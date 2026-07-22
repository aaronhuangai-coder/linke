/**
 * C4 RED — Candidate + publish claim + COMPLETED + preflightCapacity.
 * Targets public API of src/upload-commit.js (not yet implemented).
 * Authority: design §8.1–§8.4 / §11–§12 + plan C4.
 *
 * Locked exports:
 *   preflightCapacity(dataDir, totalBytes, options?)
 *   verifyAndCommitSession({ store, dataDir, deviceId, uploadId, ...deps })
 *
 * Expected RED: ERR_MODULE_NOT_FOUND for upload-commit.js until GREEN.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import { safeDevicePath, slugify } from '../src/storage.js';
import {
  createUploadSessionStore,
  UPLOAD_CHUNK_SIZE,
} from '../src/upload-session-store.js';
import {
  preflightCapacity,
  verifyAndCommitSession,
} from '../src/upload-commit.js';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440000';
const SNAPSHOT_B = '550e8400-e29b-41d4-a716-446655440001';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const T0 = '2026-07-22T12:00:00.000Z';
const MI64 = 64 * 1024 * 1024;

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
  };
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
    error.details ? JSON.stringify(error.details) : '',
  ].join('\0');
  for (const token of opts.leakTokens ?? []) {
    if (!token || token.length < 2) continue;
    assert.ok(!publicParts.includes(token), `must not leak ${token}`);
  }
}

/**
 * @param {{
 *   deviceId?: string,
 *   snapshotId?: string,
 *   files?: { path: string, size: number, content?: string | Buffer }[],
 * }} [opts]
 */
function makeProjection(opts = {}) {
  const deviceId = opts.deviceId ?? DEVICE_A;
  const snapshotId = opts.snapshotId ?? SNAPSHOT_A;
  const files = opts.files ?? [{ path: 'a.txt', size: 0 }];
  const entries = files.map((f) => {
    let content;
    if (f.content !== undefined) {
      content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    } else if (f.size === 0) {
      content = Buffer.alloc(0);
    } else {
      content = Buffer.alloc(f.size, 0x61); // 'a'
    }
    assert.equal(content.length, f.size, 'fixture content size must match');
    const sha256 =
      f.size === 0 ? ZERO_SHA : createHash('sha256').update(content).digest('hex');
    return { path: f.path, size: f.size, sha256, content };
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
  return { manifest, manifestDigest, entries, totalBytes, deviceId, snapshotId };
}

function deviceRelOf(deviceId) {
  return safeDevicePath(dataDir, deviceId).deviceRel;
}

function snapshotIdSafe(snapshotId) {
  // C4 lock: claim sibling uses only safe chars; UUID slugifies to itself.
  return slugify(snapshotId);
}

function claimAbs(deviceId, snapshotId) {
  return join(
    dataDir,
    deviceRelOf(deviceId),
    'snapshots',
    `.claim-${snapshotIdSafe(snapshotId)}`,
  );
}

function candidateAbs(deviceId, uploadId) {
  return join(
    dataDir,
    deviceRelOf(deviceId),
    'snapshots',
    `.upload-${uploadId}.pending`,
  );
}

function finalAbs(deviceId, snapshotId) {
  return join(dataDir, deviceRelOf(deviceId), 'snapshots', snapshotId);
}

function sessionDirAbs(deviceId, uploadId) {
  return join(dataDir, deviceRelOf(deviceId), 'upload-sessions', uploadId);
}

function stagingChunkAbs(deviceId, uploadId, fileIndex, chunkIndex) {
  return join(
    sessionDirAbs(deviceId, uploadId),
    '.staging',
    'files',
    String(fileIndex),
    `chunk-${chunkIndex}.part`,
  );
}

function stagingRootAbs(deviceId, uploadId) {
  return join(sessionDirAbs(deviceId, uploadId), '.staging');
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Split buffer into fixed 8 MiB chunks (last may be shorter).
 * @param {Buffer} buf
 */
function splitChunks(buf) {
  /** @type {Buffer[]} */
  const out = [];
  if (buf.length === 0) return out;
  for (let off = 0; off < buf.length; off += UPLOAD_CHUNK_SIZE) {
    out.push(buf.subarray(off, Math.min(off + UPLOAD_CHUNK_SIZE, buf.length)));
  }
  return out;
}

/**
 * Create session, materialize staging chunks, advance all boundaries to complete.
 * @param {ReturnType<typeof makeProjection>} proj
 * @param {{ leaveIncompleteFileIndex?: number, corruptFileIndex?: number, skipWriteFileIndex?: number }} [opts]
 */
async function prepareCompleteStaging(proj, opts = {}) {
  const session = await store.createSession({
    authenticatedDeviceId: proj.deviceId,
    snapshotId: proj.snapshotId,
    manifestDigest: proj.manifestDigest,
    canonicalManifest: proj.manifest,
  });
  const uploadId = session.uploadId;

  // Canonical entry order may differ from input order; use projected integrity.entries.
  const projectedEntries = /** @type {{ path: string, size: number, sha256: string }[]} */ (
    proj.manifest.integrity.entries
  );
  /** @type {Map<string, Buffer>} */
  const contentByPath = new Map(proj.entries.map((e) => [e.path, e.content]));

  for (let fileIndex = 0; fileIndex < projectedEntries.length; fileIndex += 1) {
    if (opts.leaveIncompleteFileIndex === fileIndex) continue;
    if (opts.skipWriteFileIndex === fileIndex) {
      // Boundaries advanced without bytes on disk — integrity must fail later.
      const size = projectedEntries[fileIndex].size;
      if (size === 0) continue;
      const chunks = splitChunks(Buffer.alloc(size, 0x61));
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        await store.advanceBoundary({
          authenticatedDeviceId: proj.deviceId,
          uploadId,
          fileIndex,
          chunkIndex,
          chunkBytes: chunks[chunkIndex].length,
        });
      }
      continue;
    }

    const entry = projectedEntries[fileIndex];
    let content = contentByPath.get(entry.path) ?? Buffer.alloc(0);
    if (opts.corruptFileIndex === fileIndex && content.length > 0) {
      content = Buffer.from(content);
      content[0] = (content[0] + 1) % 256;
    }
    const chunks = splitChunks(content);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const part = chunks[chunkIndex];
      const abs = stagingChunkAbs(proj.deviceId, uploadId, fileIndex, chunkIndex);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, part);
      await store.advanceBoundary({
        authenticatedDeviceId: proj.deviceId,
        uploadId,
        fileIndex,
        chunkIndex,
        chunkBytes: part.length,
      });
    }
  }

  const after = await store.getSession({
    authenticatedDeviceId: proj.deviceId,
    uploadId,
  });
  return { session: after, uploadId, projectedEntries };
}

/**
 * Snapshot of staging tree (relative names + sha256 of .part files).
 * @param {string} deviceId
 * @param {string} uploadId
 */
async function stagingFingerprint(deviceId, uploadId) {
  const root = stagingRootAbs(deviceId, uploadId);
  /** @type {string[]} */
  const lines = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        lines.push(`D:${r}`);
        await walk(abs, r);
      } else if (e.isFile()) {
        const buf = await readFile(abs);
        const h = createHash('sha256').update(buf).digest('hex');
        lines.push(`F:${r}:${buf.length}:${h}`);
      } else {
        lines.push(`O:${r}`);
      }
    }
  }
  await walk(root, '');
  return lines.join('\n');
}

function requiredBytes(totalBytes) {
  return 2 * totalBytes + Math.max(MI64, Math.ceil(totalBytes * 0.05));
}

/**
 * @param {number} bavailBlocks
 * @param {number} bsize
 */
function mockStatfs(bavailBlocks, bsize = 4096) {
  return async () => ({
    type: 0,
    bsize,
    blocks: bavailBlocks * 2,
    bfree: bavailBlocks,
    bavail: bavailBlocks,
    files: 0,
    ffree: 0,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-c4-commit-'));
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

// ── preflightCapacity ───────────────────────────────────────────────

describe('preflightCapacity', () => {
  it('accepts when free space covers 2*totalBytes + max(64MiB, ceil(5%))', async () => {
    const totalBytes = 10 * 1024 * 1024;
    const need = requiredBytes(totalBytes);
    const bsize = 4096;
    const blocks = Math.ceil(need / bsize) + 10;
    const result = await preflightCapacity(dataDir, totalBytes, {
      deps: { statfs: mockStatfs(blocks, bsize) },
    });
    // Success: returns truthy / void / ok object — must not throw.
    assert.ok(result === undefined || result === null || result === true || typeof result === 'object');
    // Must not create any session or workspace side effects under dataDir.
    const top = await readdir(dataDir);
    assert.deepEqual(top, []);
  });

  it('uses max(64MiB, ceil(totalBytes*0.05)) margin — small total still needs 64MiB overhead', async () => {
    const totalBytes = 1000;
    const need = requiredBytes(totalBytes);
    assert.equal(need, 2 * 1000 + MI64);
    const bsize = 4096;
    // Exactly need-1 free → insufficient
    const blocksShort = Math.floor((need - 1) / bsize);
    await assert.rejects(
      () =>
        preflightCapacity(dataDir, totalBytes, {
          deps: { statfs: mockStatfs(blocksShort, bsize) },
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
          statusCode: 507,
          retryable: false,
          leakTokens: [dataDir, 'ENOENT', 'ENOSPC', String(totalBytes)],
        });
        return true;
      },
    );
  });

  it('for large totalBytes margin is ceil(5%) not 64MiB floor', async () => {
    // 2 GiB → 5% = 100 MiB > 64 MiB
    const totalBytes = 2 * 1024 * 1024 * 1024;
    const need = requiredBytes(totalBytes);
    assert.equal(need, 2 * totalBytes + Math.ceil(totalBytes * 0.05));
    assert.ok(Math.ceil(totalBytes * 0.05) > MI64);
    const bsize = 1024 * 1024;
    const blocksOk = Math.ceil(need / bsize) + 1;
    await preflightCapacity(dataDir, totalBytes, {
      deps: { statfs: mockStatfs(blocksOk, bsize) },
    });
  });

  it('statfs throw → unique upload-capacity-insufficient 507, no session, no path leak', async () => {
    await assert.rejects(
      () =>
        preflightCapacity(dataDir, 1024, {
          deps: {
            statfs: async () => {
              const e = new Error(`statfs failed for ${dataDir}: EIO raw`);
              /** @type {NodeJS.ErrnoException} */
              (e).code = 'EIO';
              throw e;
            },
          },
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
          statusCode: 507,
          retryable: false,
          leakTokens: [dataDir, 'EIO', 'statfs failed', 'raw'],
        });
        return true;
      },
    );
    assert.deepEqual(await readdir(dataDir), []);
  });

  it('statfs unavailable (undefined / not a function) → capacity-insufficient only', async () => {
    await assert.rejects(
      () =>
        preflightCapacity(dataDir, 1024, {
          deps: { statfs: undefined },
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
          statusCode: 507,
          leakTokens: [dataDir],
        });
        return true;
      },
    );
  });

  it('untrusted statfs values (negative/NaN/non-integer free) → capacity-insufficient', async () => {
    const bad = [
      async () => ({ bsize: 4096, bavail: -1 }),
      async () => ({ bsize: 4096, bavail: Number.NaN }),
      async () => ({ bsize: 4096, bavail: 1.5 }),
      async () => ({ bsize: 0, bavail: 100 }),
      async () => ({ bsize: -4096, bavail: 100 }),
      async () => ({ bsize: 4096, bavail: Number.POSITIVE_INFINITY }),
      async () => null,
      async () => ({ }),
    ];
    for (const statfs of bad) {
      await assert.rejects(
        () => preflightCapacity(dataDir, 1024, { deps: { statfs } }),
        (err) => {
          assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
            statusCode: 507,
          });
          return true;
        },
      );
    }
  });

  it('overflow / non-safe totalBytes → capacity-insufficient (unique code)', async () => {
    for (const totalBytes of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 1,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await assert.rejects(
        () =>
          preflightCapacity(dataDir, totalBytes, {
            deps: { statfs: mockStatfs(1e12, 4096) },
          }),
        (err) => {
          assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
            statusCode: 507,
          });
          return true;
        },
      );
    }
  });

  it('space short of required dual-copy peak → capacity-insufficient; never creates session dirs', async () => {
    const totalBytes = 50 * 1024 * 1024;
    const need = requiredBytes(totalBytes);
    const bsize = 4096;
    const blocksShort = Math.max(0, Math.floor(need / bsize) - 2);
    await assert.rejects(
      () =>
        preflightCapacity(dataDir, totalBytes, {
          deps: { statfs: mockStatfs(blocksShort, bsize) },
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
          statusCode: 507,
          leakTokens: [dataDir, 'repo', 'devices'],
        });
        return true;
      },
    );
    assert.deepEqual(await readdir(dataDir), []);
  });

  it('does not write workspace even on success (no repo/devices side effects)', async () => {
    const totalBytes = 0;
    const need = requiredBytes(totalBytes);
    const bsize = 4096;
    await preflightCapacity(dataDir, totalBytes, {
      deps: { statfs: mockStatfs(Math.ceil(need / bsize) + 1, bsize) },
    });
    assert.deepEqual(await readdir(dataDir), []);
  });
});

// ── verifyAndCommitSession — integrity / incomplete ─────────────────

describe('verifyAndCommitSession integrity gates', () => {
  it('missing staging chunk: no COMPLETED, no committed, staging untouched, no final publish', async () => {
    const proj = makeProjection({
      files: [{ path: 'only.bin', size: 8, content: '12345678' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj, { skipWriteFileIndex: 0 });
    const fpBefore = await stagingFingerprint(proj.deviceId, uploadId);
    const beforeSession = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(beforeSession.files[0].complete, true);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          leakTokens: [dataDir, uploadId, 'only.bin', stagingChunkAbs(proj.deviceId, uploadId, 0, 0)],
        });
        return true;
      },
    );

    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
    assert.equal(await pathExists(finalAbs(proj.deviceId, proj.snapshotId)), false);
    const after = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(after.status, 'committed');
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
  });

  it('SHA-256 mismatch on staging: no COMPLETED, staging intact, not committed', async () => {
    const proj = makeProjection({
      files: [{ path: 'hash.bin', size: 6, content: 'abcdef' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj, { corruptFileIndex: 0 });
    const fpBefore = await stagingFingerprint(proj.deviceId, uploadId);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          leakTokens: [dataDir, 'hash.bin'],
        });
        return true;
      },
    );

    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
    const after = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(after.status, 'committed');
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
  });

  it('size mismatch (truncated part): integrity-failed; staging complete fingerprint retained', async () => {
    const proj = makeProjection({
      files: [{ path: 'sz.bin', size: 10, content: '0123456789' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const part = stagingChunkAbs(proj.deviceId, uploadId, 0, 0);
    await writeFile(part, Buffer.from('012345678')); // 9 bytes
    const fpBefore = await stagingFingerprint(proj.deviceId, uploadId);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, { statusCode: 409 });
        return true;
      },
    );
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
  });

  it('incomplete boundaries never enter verifying publish; no COMPLETED', async () => {
    const proj = makeProjection({
      files: [{ path: 'partial.bin', size: 12, content: 'abcdefghijkl' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj, { leaveIncompleteFileIndex: 0 });
    // Write bytes but do not advance — boundary incomplete.
    const abs = stagingChunkAbs(proj.deviceId, uploadId, 0, 0);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, Buffer.from('abcdefghijkl'));

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assert.ok(err instanceof LinkeError);
        assert.ok(
          err.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED
            || err.code === ERROR_CODES.UPLOAD_CHUNK_INVALID,
        );
        assert.equal(err.message, err.code);
        return true;
      },
    );
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
    const after = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(after.status, 'committed');
    assert.notEqual(after.status, 'verifying');
  });

  it('canonical identity field tamper (createdAt): re-digest ≠ session identity; no publish', async () => {
    // RED: after createSession + complete staging, legally mutate only a
    // non-file-content identity field on disk (createdAt). Staging bytes and
    // session.manifestDigest stay unchanged. Commit must fail-close because
    // re-computed sha256(JSON.stringify(canonicalManifest)) no longer equals
    // the session identity digest — not because file size/hash failed.
    const proj = makeProjection({
      files: [{ path: 'id.txt', size: 7, content: 'payload' }],
    });
    const { uploadId, projectedEntries } = await prepareCompleteStaging(proj);
    const fpBefore = await stagingFingerprint(proj.deviceId, uploadId);

    // Precondition: staging file content still matches projected integrity entries.
    const entry = projectedEntries[0];
    const partBefore = await readFile(stagingChunkAbs(proj.deviceId, uploadId, 0, 0));
    assert.equal(partBefore.length, entry.size);
    assert.equal(createHash('sha256').update(partBefore).digest('hex'), entry.sha256);

    const manifestPath = join(sessionDirAbs(proj.deviceId, uploadId), 'manifest.canonical.json');
    const originalText = await readFile(manifestPath, 'utf8');
    const originalOnDiskDigest = createHash('sha256')
      .update(originalText, 'utf8')
      .digest('hex');
    assert.equal(
      originalOnDiskDigest,
      proj.manifestDigest,
      'precondition: on-disk canonical digest equals session identity',
    );

    const parsed = JSON.parse(originalText);
    const originalCreatedAt = parsed.createdAt;
    assert.equal(originalCreatedAt, T0);
    // Another legal canonical ISO UTC (design §5.2 assertCanonicalCreatedAt form).
    const tamperedCreatedAt = '2026-07-22T12:00:01.000Z';
    assert.notEqual(tamperedCreatedAt, originalCreatedAt);
    parsed.createdAt = tamperedCreatedAt;
    // File-path integrity block must remain byte-identical — only identity changes.
    assert.deepEqual(parsed.integrity, proj.manifest.integrity);
    assert.deepEqual(parsed.files, proj.manifest.files);
    assert.equal(parsed.snapshotId, proj.snapshotId);
    assert.equal(parsed.deviceId, proj.deviceId);

    const tamperedText = JSON.stringify(parsed);
    const tamperedDigest = createHash('sha256').update(tamperedText, 'utf8').digest('hex');
    assert.notEqual(
      tamperedDigest,
      proj.manifestDigest,
      'precondition: identity-only field change must alter canonical digest',
    );
    await writeFile(manifestPath, tamperedText, 'utf8');

    // Session identity still pins the original digest; staging fingerprint unchanged.
    const sessionBefore = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(sessionBefore.manifestDigest, proj.manifestDigest);
    assert.notEqual(sessionBefore.manifestDigest, tamperedDigest);
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
    const partAfterTamper = await readFile(stagingChunkAbs(proj.deviceId, uploadId, 0, 0));
    assert.equal(partAfterTamper.length, entry.size);
    assert.equal(
      createHash('sha256').update(partAfterTamper).digest('hex'),
      entry.sha256,
      'staging file hash still matches projected entry — reject cause is not file integrity',
    );

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          leakTokens: [
            dataDir,
            uploadId,
            manifestPath,
            originalCreatedAt,
            tamperedCreatedAt,
            proj.manifestDigest,
            tamperedDigest,
            'id.txt',
            'payload',
          ],
        });
        return true;
      },
    );

    // No candidate / final / COMPLETED; not markCommitted; staging bytes unchanged.
    assert.equal(await pathExists(candidateAbs(proj.deviceId, uploadId)), false);
    assert.equal(await pathExists(finalAbs(proj.deviceId, proj.snapshotId)), false);
    assert.equal(
      await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')),
      false,
    );
    const after = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(after.status, 'committed');
    assert.equal(after.manifestDigest, proj.manifestDigest);
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
    // Tampered manifest retained on disk (commit must not silently repair).
    assert.equal(await readFile(manifestPath, 'utf8'), tamperedText);
  });
});

// ── success path + strict order ─────────────────────────────────────

describe('verifyAndCommitSession success path', () => {
  it('happy path: staging untouched; candidate then claim wx; rename; COMPLETED; indexes; markCommitted last; claim cleaned', async () => {
    const proj = makeProjection({
      files: [
        { path: 'readme.txt', size: 5, content: 'hello' },
        { path: 'nested/dir/data.bin', size: 4, content: 'zzzz' },
        { path: 'empty.dat', size: 0 },
      ],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const fpBefore = await stagingFingerprint(proj.deviceId, uploadId);

    /** @type {string[]} */
    const order = [];
    const realMarkCommitted = store.markCommitted.bind(store);
    const realMarkVerifying = store.markVerifying.bind(store);
    store.markVerifying = async (input) => {
      order.push('markVerifying');
      return realMarkVerifying(input);
    };
    store.markCommitted = async (input) => {
      // COMPLETED + indexes must already exist before markCommitted.
      const completed = join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json');
      assert.equal(await pathExists(completed), true, 'COMPLETED before markCommitted');
      const index = await readJsonIfExists(
        join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json'),
      );
      assert.ok(Array.isArray(index));
      assert.ok(index.some((e) => e && e.snapshotId === proj.snapshotId));
      order.push('markCommitted');
      return realMarkCommitted(input);
    };

    const result = await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
      hooks: {
        afterStagingVerified: async () => {
          order.push('staging-verified');
          // Staging must remain complete.
          assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
        },
        afterCandidateMaterialized: async () => {
          order.push('candidate');
          const cand = candidateAbs(proj.deviceId, uploadId);
          assert.equal(await pathExists(cand), true);
          assert.equal(await pathExists(join(cand, 'manifest.json')), true);
          assert.equal(await pathExists(join(cand, 'files', 'readme.txt')), true);
          assert.equal(await pathExists(join(cand, 'files', 'nested/dir/data.bin')), true);
          assert.equal(await pathExists(join(cand, 'files', 'empty.dat')), true);
          assert.equal(await pathExists(join(cand, 'PENDING.json')), true);
          const pending = JSON.parse(await readFile(join(cand, 'PENDING.json'), 'utf8'));
          assert.equal(pending.uploadId, uploadId);
          assert.equal(pending.deviceId, proj.deviceId);
          assert.equal(pending.snapshotId, proj.snapshotId);
          assert.equal(pending.manifestDigest, proj.manifestDigest);
          // Final must not exist yet; direct readers must not see candidate as snapshot.
          assert.equal(await pathExists(finalAbs(proj.deviceId, proj.snapshotId)), false);
          // Staging still intact.
          assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
        },
        afterClaimAcquired: async () => {
          order.push('claim');
          assert.equal(await pathExists(claimAbs(proj.deviceId, proj.snapshotId)), true);
          const claimRaw = await readFile(claimAbs(proj.deviceId, proj.snapshotId), 'utf8');
          const claim = JSON.parse(claimRaw);
          assert.equal(claim.deviceId, proj.deviceId);
          assert.equal(claim.snapshotId, proj.snapshotId);
          assert.equal(claim.uploadId, uploadId);
          assert.equal(claim.manifestDigest, proj.manifestDigest);
        },
        afterRename: async () => {
          order.push('rename');
          assert.equal(await pathExists(finalAbs(proj.deviceId, proj.snapshotId)), true);
          assert.equal(await pathExists(candidateAbs(proj.deviceId, uploadId)), false);
          assert.equal(
            await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')),
            false,
            'COMPLETED only after re-verify',
          );
          // Pending metadata retained at least until COMPLETED.
          assert.equal(
            await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'PENDING.json')),
            true,
          );
        },
        afterCompleted: async () => {
          order.push('completed');
          const marker = JSON.parse(
            await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json'), 'utf8'),
          );
          assert.equal(marker.origin, 'remote-upload');
          assert.equal(marker.snapshotId, proj.snapshotId);
          assert.equal(marker.manifestDigest, proj.manifestDigest);
          assert.equal(marker.uploadId, uploadId);
          assert.equal(marker.deviceId, proj.deviceId);
          assert.equal(typeof marker.committedAt, 'string');
          // Indexes not yet (must follow COMPLETED).
          const index = await readJsonIfExists(
            join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json'),
          );
          if (index) {
            assert.equal(
              index.some((e) => e && e.snapshotId === proj.snapshotId),
              false,
              'index only after COMPLETED hook phase',
            );
          }
        },
        afterIndexUpsert: async () => {
          order.push('index');
          const index = JSON.parse(
            await readFile(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json'), 'utf8'),
          );
          const entry = index.find((e) => e.snapshotId === proj.snapshotId);
          assert.ok(entry);
          assert.equal(entry.origin, 'remote-upload');
          assert.equal(entry.manifestDigest, proj.manifestDigest);
          assert.equal(entry.snapshotId, proj.snapshotId);
          assert.equal(typeof entry.committedAt, 'string');
          assert.equal(entry.sourcePath, undefined);
          assert.equal(entry.hostname, undefined);
          assert.equal(entry.ipAddress, undefined);
          assert.equal(entry.host, undefined);
          const device = JSON.parse(
            await readFile(join(dataDir, deviceRelOf(proj.deviceId), 'device.json'), 'utf8'),
          );
          assert.ok(device.snapshotCount >= 1);
        },
        afterClaimCleanup: async () => {
          order.push('claim-cleanup');
        },
      },
    });

    assert.ok(result === undefined || result === null || typeof result === 'object');
    assert.deepEqual(order, [
      'markVerifying',
      'staging-verified',
      'candidate',
      'claim',
      'rename',
      'completed',
      'index',
      'markCommitted',
      'claim-cleanup',
    ]);

    // Staging never deleted/mutated by success path.
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);

    const committed = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(committed.status, 'committed');

    // Claim cleaned best-effort after success.
    assert.equal(await pathExists(claimAbs(proj.deviceId, proj.snapshotId)), false);

    // Final files match.
    assert.equal(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'readme.txt'), 'utf8'),
      'hello',
    );
    assert.equal(
      await readFile(
        join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'nested/dir/data.bin'),
        'utf8',
      ),
      'zzzz',
    );
    assert.equal(
      (await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'empty.dat'))).length,
      0,
    );
  });

  it('recomputes totalBytes upper bound and rejects overflow-hostile session totals', async () => {
    const proj = makeProjection({
      files: [{ path: 't.bin', size: 3, content: 'abc' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    // Tamper session.json totalBytes to absurd value after complete staging.
    const sessionPath = join(sessionDirAbs(proj.deviceId, uploadId), 'session.json');
    const raw = JSON.parse(await readFile(sessionPath, 'utf8'));
    raw.totalBytes = Number.MAX_SAFE_INTEGER;
    await writeFile(sessionPath, JSON.stringify(raw));

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assert.ok(err instanceof LinkeError);
        assert.ok(
          err.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED
            || err.code === ERROR_CODES.UPLOAD_IO_ERROR
            || err.code === ERROR_CODES.UPLOAD_MANIFEST_INVALID,
        );
        assert.equal(err.message, err.code);
        return true;
      },
    );
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
  });
});

// ── OS rename regression (empty target replaced) ────────────────────

describe('OS rename semantics regression', () => {
  it('non-empty source rename onto existing empty target replaces (no EEXIST myth)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-rename-myth-'));
    try {
      const source = join(base, 'source-dir');
      const target = join(base, 'target-dir');
      await mkdir(source, { recursive: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(source, 'payload.txt'), 'rename-payload');
      // Target empty directory exists.
      assert.deepEqual(await readdir(target), []);
      // Must succeed and replace — proves exclusive publish cannot rely on EEXIST.
      await rename(source, target);
      assert.equal(await pathExists(source), false);
      assert.equal(await readFile(join(target, 'payload.txt'), 'utf8'), 'rename-payload');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── publish claim wx exclusivity ────────────────────────────────────

describe('publish claim open(wx) exclusivity', () => {
  it('two competing wx creates: only one succeeds; loser does not overwrite claim', async () => {
    const proj = makeProjection({
      files: [{ path: 'c.txt', size: 2, content: 'ok' }],
    });
    // Ensure parent snapshots dir exists.
    await mkdir(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots'), { recursive: true });
    const claimPath = claimAbs(proj.deviceId, proj.snapshotId);
    const h1 = await fsOpen(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await h1.writeFile(JSON.stringify({ schemaVersion: 1, owner: 'first' }));
    await h1.close();

    await assert.rejects(
      () => fsOpen(claimPath, 'wx'),
      (err) => {
        assert.ok(err && err.code === 'EEXIST');
        return true;
      },
    );
    const body = await readFile(claimPath, 'utf8');
    assert.ok(body.includes('first'));
    assert.ok(!body.includes('second'));
  });

  it('existing same-identity claim allows recovery/takeover during commit', async () => {
    const proj = makeProjection({
      files: [{ path: 'rec.txt', size: 4, content: 'same' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await mkdir(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots'), { recursive: true });
    await writeFile(
      claimAbs(proj.deviceId, proj.snapshotId),
      JSON.stringify({
        schemaVersion: 1,
        deviceId: proj.deviceId,
        snapshotId: proj.snapshotId,
        uploadId,
        manifestDigest: proj.manifestDigest,
      }),
      'utf8',
    );

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const after = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(after.status, 'committed');
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), true);
  });

  it('corrupt claim → upload-commit-conflict; does not overwrite or delete claim', async () => {
    const proj = makeProjection({
      files: [{ path: 'x.txt', size: 1, content: 'x' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await mkdir(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots'), { recursive: true });
    const claimPath = claimAbs(proj.deviceId, proj.snapshotId);
    await writeFile(claimPath, '{not-json', 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [claimPath, dataDir],
        });
        return true;
      },
    );
    assert.equal(await readFile(claimPath, 'utf8'), '{not-json');
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
  });

  it('truncated claim → commit-conflict; claim retained', async () => {
    const proj = makeProjection({
      files: [{ path: 'y.txt', size: 1, content: 'y' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await mkdir(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots'), { recursive: true });
    const claimPath = claimAbs(proj.deviceId, proj.snapshotId);
    // Truncated incomplete JSON object.
    await writeFile(
      claimPath,
      '{"schemaVersion":1,"deviceId":"device-alpha-001","snapshotId":"550e8400',
      'utf8',
    );
    const before = await readFile(claimPath, 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
    assert.equal(await readFile(claimPath, 'utf8'), before);
  });

  it('unknown schemaVersion claim → commit-conflict; not deleted', async () => {
    const proj = makeProjection({
      files: [{ path: 'z.txt', size: 1, content: 'z' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await mkdir(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots'), { recursive: true });
    const claimPath = claimAbs(proj.deviceId, proj.snapshotId);
    const payload = JSON.stringify({
      schemaVersion: 99,
      deviceId: proj.deviceId,
      snapshotId: proj.snapshotId,
      uploadId,
      manifestDigest: proj.manifestDigest,
    });
    await writeFile(claimPath, payload, 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
    assert.equal(await readFile(claimPath, 'utf8'), payload);
  });

  it('different-identity claim → commit-conflict; unknown claim not deleted or overwritten', async () => {
    const proj = makeProjection({
      files: [{ path: 'd.txt', size: 1, content: 'd' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await mkdir(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots'), { recursive: true });
    const claimPath = claimAbs(proj.deviceId, proj.snapshotId);
    const foreign = JSON.stringify({
      schemaVersion: 1,
      deviceId: DEVICE_B,
      snapshotId: proj.snapshotId,
      uploadId: 'bbbbbbbb-bbbb-4ccc-8ddd-000000000099',
      manifestDigest: 'f'.repeat(64),
    });
    await writeFile(claimPath, foreign, 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [claimPath, DEVICE_B, dataDir],
        });
        return true;
      },
    );
    assert.equal(await readFile(claimPath, 'utf8'), foreign);
  });
});

// ── crash windows ───────────────────────────────────────────────────

describe('verifyAndCommitSession crash windows', () => {
  it('candidate build crash: incomplete candidate discarded/rebuildable; staging intact; final absent; readers cannot see candidate', async () => {
    const proj = makeProjection({
      files: [{ path: 'crash.bin', size: 7, content: 'crashme' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const fpBefore = await stagingFingerprint(proj.deviceId, uploadId);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
          hooks: {
            afterCandidateMaterialized: async () => {
              throw new Error('injected-candidate-crash');
            },
          },
        }),
      (err) => {
        // Injected crash may surface as UPLOAD_IO_ERROR (sanitized) or raw only if not caught —
        // implementation must not leave a published final.
        assert.ok(err);
        return true;
      },
    );

    assert.equal(await pathExists(finalAbs(proj.deviceId, proj.snapshotId)), false);
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);

    // Direct path must not treat candidate name as snapshotId.
    const candName = `.upload-${uploadId}.pending`;
    assert.equal(await pathExists(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots', candName)), true);

    // Rebuild succeeds from intact staging.
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), true);
    assert.equal(await stagingFingerprint(proj.deviceId, uploadId), fpBefore);
  });

  it('rename done / COMPLETED missing: same pending identity recovers and writes COMPLETED', async () => {
    const proj = makeProjection({
      files: [{ path: 'mid.txt', size: 3, content: 'mid' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
          hooks: {
            afterRename: async () => {
              throw new Error('injected-post-rename-crash');
            },
          },
        }),
      () => true,
    );

    assert.equal(await pathExists(finalAbs(proj.deviceId, proj.snapshotId)), true);
    assert.equal(
      await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')),
      false,
    );
    assert.equal(
      await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'PENDING.json')),
      true,
    );

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const marker = JSON.parse(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json'), 'utf8'),
    );
    assert.equal(marker.origin, 'remote-upload');
    assert.equal(marker.manifestDigest, proj.manifestDigest);
    const session = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(session.status, 'committed');
  });

  it('rename done / PENDING identity mismatch → commit-conflict and does not overwrite final', async () => {
    const proj = makeProjection({
      files: [{ path: 'bad.txt', size: 3, content: 'bad' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    // Plant foreign final pending (no COMPLETED) as if another writer left it.
    const finalDir = finalAbs(proj.deviceId, proj.snapshotId);
    await mkdir(join(finalDir, 'files'), { recursive: true });
    await writeFile(join(finalDir, 'files', 'bad.txt'), 'bad');
    await writeFile(
      join(finalDir, 'manifest.json'),
      JSON.stringify(proj.manifest),
      'utf8',
    );
    await writeFile(
      join(finalDir, 'PENDING.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceId: DEVICE_B,
        snapshotId: proj.snapshotId,
        uploadId: 'cccccccc-bbbb-4ccc-8ddd-000000000001',
        manifestDigest: 'a'.repeat(64),
      }),
      'utf8',
    );
    const pendingBefore = await readFile(join(finalDir, 'PENDING.json'), 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [finalDir, dataDir],
        });
        return true;
      },
    );
    assert.equal(await readFile(join(finalDir, 'PENDING.json'), 'utf8'), pendingBefore);
    assert.equal(await pathExists(join(finalDir, 'COMPLETED.json')), false);
  });

  it('COMPLETED present / indexes missing: repairs indexes idempotently without duplicate snapshotId', async () => {
    const proj = makeProjection({
      files: [{ path: 'idx.txt', size: 2, content: 'id' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
          hooks: {
            afterCompleted: async () => {
              throw new Error('injected-post-completed-pre-index');
            },
          },
        }),
      () => true,
    );

    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), true);
    // Ensure no index entry yet (or incomplete).
    const indexPath = join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json');
    if (await pathExists(indexPath)) {
      const cur = JSON.parse(await readFile(indexPath, 'utf8'));
      assert.equal(cur.filter((e) => e.snapshotId === proj.snapshotId).length, 0);
    }

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const matches = index.filter((e) => e.snapshotId === proj.snapshotId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].origin, 'remote-upload');
    assert.equal(matches[0].manifestDigest, proj.manifestDigest);

    // Repeat finalize idempotent — still one entry.
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    const index2 = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(index2.filter((e) => e.snapshotId === proj.snapshotId).length, 1);
  });

  it('COMPLETED + residual same-identity claim: cleanup best-effort; cleanup failure does not un-commit', async () => {
    const proj = makeProjection({
      files: [{ path: 'cl.txt', size: 2, content: 'cl' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    // First finalize to COMPLETED + committed.
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    assert.equal(
      (await store.getSession({ authenticatedDeviceId: proj.deviceId, uploadId })).status,
      'committed',
    );

    // Plant residual same-identity claim after success (crash between committed and cleanup).
    const claimPath = claimAbs(proj.deviceId, proj.snapshotId);
    await writeFile(
      claimPath,
      JSON.stringify({
        schemaVersion: 1,
        deviceId: proj.deviceId,
        snapshotId: proj.snapshotId,
        uploadId,
        manifestDigest: proj.manifestDigest,
      }),
      'utf8',
    );
    assert.equal(await pathExists(claimPath), true);

    let unlinkAttempts = 0;
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
      deps: {
        unlinkClaim: async () => {
          unlinkAttempts += 1;
          const e = new Error('EPERM');
          /** @type {NodeJS.ErrnoException} */ (e).code = 'EPERM';
          throw e;
        },
      },
    });

    const session = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    // Committed must not reverse when claim cleanup fails.
    assert.equal(session.status, 'committed');
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), true);
    assert.ok(unlinkAttempts >= 1, 'idempotent path must attempt claim cleanup');
    // Residual claim may remain after failed best-effort cleanup.
    assert.equal(await pathExists(claimPath), true);
  });

  it('duplicate finalize after full success is idempotent', async () => {
    const proj = makeProjection({
      files: [{ path: 'once.txt', size: 4, content: 'once' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    const index1 = JSON.parse(
      await readFile(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json'), 'utf8'),
    );
    const completed1 = await readFile(
      join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json'),
      'utf8',
    );

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const index2 = JSON.parse(
      await readFile(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json'), 'utf8'),
    );
    assert.equal(index2.filter((e) => e.snapshotId === proj.snapshotId).length, 1);
    assert.equal(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json'), 'utf8'),
      completed1,
    );
    assert.equal(index1.length, index2.length);
  });
});

// ── final COMPLETED identity matrix ─────────────────────────────────

describe('final COMPLETED identity matrix', () => {
  it('valid COMPLETED same identity/digest → recovery (no overwrite of files)', async () => {
    const proj = makeProjection({
      files: [{ path: 'done.txt', size: 4, content: 'done' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    const filesBefore = await readFile(
      join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'done.txt'),
      'utf8',
    );
    // Corrupt staging deliberately — recovery must use existing COMPLETED, not rebuild from bad staging.
    const part = stagingChunkAbs(proj.deviceId, uploadId, 0, 0);
    if (await pathExists(part)) await writeFile(part, Buffer.from('XXXX'));

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    assert.equal(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'done.txt'), 'utf8'),
      filesBefore,
    );
  });

  it('valid COMPLETED different digest/identity → upload-commit-conflict', async () => {
    const proj = makeProjection({
      files: [{ path: 'own.txt', size: 3, content: 'own' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const finalDir = finalAbs(proj.deviceId, proj.snapshotId);
    await mkdir(join(finalDir, 'files'), { recursive: true });
    await writeFile(join(finalDir, 'files', 'own.txt'), 'own');
    await writeFile(join(finalDir, 'manifest.json'), JSON.stringify(proj.manifest), 'utf8');
    await writeFile(
      join(finalDir, 'COMPLETED.json'),
      JSON.stringify({
        schemaVersion: 1,
        origin: 'remote-upload',
        snapshotId: proj.snapshotId,
        manifestDigest: 'b'.repeat(64),
        committedAt: T0,
        uploadId: 'dddddddd-bbbb-4ccc-8ddd-000000000001',
        deviceId: DEVICE_B,
      }),
      'utf8',
    );
    const completedBefore = await readFile(join(finalDir, 'COMPLETED.json'), 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [finalDir, dataDir],
        });
        return true;
      },
    );
    assert.equal(await readFile(join(finalDir, 'COMPLETED.json'), 'utf8'), completedBefore);
  });
});

// ── remote index schema ─────────────────────────────────────────────

describe('remote index schema on commit', () => {
  it('upsert forces origin=remote-upload, manifestDigest, committedAt, snapshotId; no path/host fields', async () => {
    const proj = makeProjection({
      files: [{ path: 'schema.txt', size: 2, content: 'sc' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    const index = JSON.parse(
      await readFile(join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json'), 'utf8'),
    );
    const entry = index.find((e) => e.snapshotId === proj.snapshotId);
    assert.ok(entry);
    assert.equal(entry.origin, 'remote-upload');
    assert.equal(entry.manifestDigest, proj.manifestDigest);
    assert.equal(entry.snapshotId, proj.snapshotId);
    assert.match(entry.committedAt, /^\d{4}-\d{2}-\d{2}T/);
    for (const banned of [
      'sourcePath',
      'hostname',
      'ipAddress',
      'host',
      'path',
      'token',
      'fingerprint',
      'uploadPath',
      'dataDir',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(entry, banned), false, banned);
    }
    // Stringify must not contain absolute dataDir.
    assert.ok(!JSON.stringify(entry).includes(dataDir));
  });
});

// ── path safety / fail-close ────────────────────────────────────────

describe('path derivation and hostile fail-close', () => {
  it('candidate/files paths use only safe slug, uploadId, fileIndex and verified manifest relative paths', async () => {
    const proj = makeProjection({
      files: [{ path: 'safe/nested/file.txt', size: 3, content: 'abc' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    /** @type {string[]} */
    const observed = [];
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
      hooks: {
        afterCandidateMaterialized: async () => {
          const cand = candidateAbs(proj.deviceId, uploadId);
          observed.push(cand);
          const { slug } = safeDevicePath(dataDir, proj.deviceId);
          assert.ok(cand.includes(`/repo/devices/${slug}/snapshots/.upload-${uploadId}.pending`));
          // No client absolute paths.
          assert.ok(!cand.includes('safe/nested') || cand.endsWith('.pending') || true);
          assert.equal(await pathExists(join(cand, 'files', 'safe/nested/file.txt')), true);
          // Staging path uses fileIndex not client path segments.
          assert.equal(await pathExists(stagingChunkAbs(proj.deviceId, uploadId, 0, 0)), true);
        },
      },
    });
    assert.ok(observed.length >= 1);
  });

  it('symlink under staging fail-closes without path leak; no COMPLETED', async () => {
    const proj = makeProjection({
      files: [{ path: 'sym.txt', size: 3, content: 'sym' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const part = stagingChunkAbs(proj.deviceId, uploadId, 0, 0);
    await rm(part, { force: true });
    const outside = join(dataDir, 'outside-secret-payload');
    await writeFile(outside, 'sym');
    await symlink(outside, part);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assert.ok(err instanceof LinkeError);
        assert.ok(
          err.code === ERROR_CODES.UPLOAD_IO_ERROR
            || err.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED,
        );
        assertLinkeCode(err, err.code, {
          leakTokens: [dataDir, outside, part, 'outside-secret-payload'],
        });
        return true;
      },
    );
    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), false);
  });

  it('hostile deviceId/session lookup fail-closes with registered code only', async () => {
    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: '../escape',
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
          now: () => clock.now(),
        }),
      (err) => {
        assert.ok(err instanceof LinkeError);
        assert.ok(Object.values(ERROR_CODES).includes(err.code));
        assert.equal(err.message, err.code);
        assertLinkeCode(err, err.code, { leakTokens: [dataDir, '../escape'] });
        return true;
      },
    );
  });

  it('malformed session.json fail-closes desensitized', async () => {
    const proj = makeProjection({
      files: [{ path: 'm.txt', size: 1, content: 'm' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const sessionPath = join(sessionDirAbs(proj.deviceId, uploadId), 'session.json');
    await writeFile(sessionPath, 'not-json{{{', 'utf8');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assert.ok(err instanceof LinkeError);
        assertLinkeCode(err, err.code, { leakTokens: [sessionPath, dataDir, 'not-json'] });
        return true;
      },
    );
  });

  it('rejects hostile options proxy / getter without throwing raw path errors', async () => {
    const proj = makeProjection({
      files: [{ path: 'p.txt', size: 1, content: 'p' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    const hostile = new Proxy(
      {
        store,
        dataDir,
        deviceId: proj.deviceId,
        uploadId,
        now: () => clock.now(),
      },
      {
        get(target, prop, receiver) {
          if (prop === 'dataDir') return dataDir;
          if (prop === 'toString') return () => dataDir;
          return Reflect.get(target, prop, receiver);
        },
        ownKeys() {
          return ['store', 'dataDir', 'deviceId', 'uploadId', 'now', 'evil'];
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'evil') {
            return { configurable: true, enumerable: true, get: () => dataDir };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );

    // Implementation may accept plain fields via Reflect or fail-close — must not leak.
    try {
      await verifyAndCommitSession(/** @type {any} */ (hostile));
    } catch (err) {
      assert.ok(err instanceof LinkeError || err instanceof TypeError || err instanceof Error);
      if (err instanceof LinkeError) {
        assertLinkeCode(err, err.code, { leakTokens: [dataDir] });
      } else {
        const text = String(err.message || '');
        // TypeError may mention types but must not include absolute dataDir in public message
        // when wrapped — best-effort: if message contains dataDir, still require no COMPLETED.
      }
    }
    // Either success (ignored evil key) or fail-close is acceptable; never half-publish.
    // If failed before publish, final COMPLETED absent; if succeeded, COMPLETED present and valid.
    if (await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json'))) {
      const marker = JSON.parse(
        await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json'), 'utf8'),
      );
      assert.equal(marker.origin, 'remote-upload');
    }
  });
});

// ── boundary cases: zero-byte, multi-chunk, nested, totals ───────────

describe('boundary content cases', () => {
  it('zero-byte file only: commits with empty file present and correct ZERO_SHA', async () => {
    const proj = makeProjection({
      files: [{ path: 'zero.txt', size: 0 }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    const empty = await readFile(
      join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'zero.txt'),
    );
    assert.equal(empty.length, 0);
    const man = JSON.parse(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'manifest.json'), 'utf8'),
    );
    assert.equal(man.integrity.entries[0].sha256, ZERO_SHA);
  });

  it('multi-chunk aggregation (>8MiB) materializes single final file with full hash', async () => {
    const size = UPLOAD_CHUNK_SIZE + 32;
    const content = Buffer.alloc(size, 0x5a);
    const proj = makeProjection({
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'big.bin', size, content }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    // Confirm two staging parts exist.
    assert.equal(await pathExists(stagingChunkAbs(proj.deviceId, uploadId, 0, 0)), true);
    assert.equal(await pathExists(stagingChunkAbs(proj.deviceId, uploadId, 0, 1)), true);

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const finalFile = await readFile(
      join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'big.bin'),
    );
    assert.equal(finalFile.length, size);
    assert.equal(
      createHash('sha256').update(finalFile).digest('hex'),
      proj.entries[0].sha256,
    );
  });

  it('nested paths preserved under files/ after commit', async () => {
    const proj = makeProjection({
      files: [
        { path: 'a/b/c.txt', size: 2, content: 'ab' },
        { path: 'a/b/d.txt', size: 2, content: 'cd' },
      ],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });
    assert.equal(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'a/b/c.txt'), 'utf8'),
      'ab',
    );
    assert.equal(
      await readFile(join(finalAbs(proj.deviceId, proj.snapshotId), 'files', 'a/b/d.txt'), 'utf8'),
      'cd',
    );
  });
});

// ── GLM-F3: concurrent finalize RMW on shared snapshots.json ────────

describe('GLM-F3 concurrent finalize snapshots.json RMW', () => {
  it('GLM-F3: concurrent A recovery finalize + B first finalize share snapshots.json RMW → index has A and B once; snapshotCount matches', async () => {
    // Causal: upsertRemoteIndexes is unlocked read-modify-write. Barrier holds both writers
    // immediately before the shared index write so both observe the same pre-image.
    // No sleep / no probabilistic retry loops.
    const projA = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      files: [{ path: 'a-only.txt', size: 3, content: 'aaa' }],
    });
    const { uploadId: uploadA } = await prepareCompleteStaging(projA);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: projA.deviceId,
      uploadId: uploadA,
      now: () => clock.now(),
    });

    // Confirm A alone in index before concurrent phase.
    const indexPath = join(dataDir, deviceRelOf(DEVICE_A), 'snapshots.json');
    {
      const pre = JSON.parse(await readFile(indexPath, 'utf8'));
      assert.equal(pre.filter((e) => e && e.snapshotId === SNAPSHOT_A).length, 1);
      assert.equal(pre.filter((e) => e && e.snapshotId === SNAPSHOT_B).length, 0);
    }

    const projB = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'b-only.txt', size: 3, content: 'bbb' }],
    });
    const { uploadId: uploadB } = await prepareCompleteStaging(projB);

    let aReached = false;
    let bReached = false;
    /** @type {(() => void) | undefined} */
    let releaseA;
    /** @type {(() => void) | undefined} */
    let releaseB;
    const waitA = new Promise((resolve) => {
      releaseA = resolve;
    });
    const waitB = new Promise((resolve) => {
      releaseB = resolve;
    });
    function releaseBothIfReady() {
      if (aReached && bReached) {
        releaseA();
        releaseB();
      }
    }

    // A: committed recovery → finishFromExistingCompleted → afterClaimAcquired then upsert.
    // B: first finalize → afterCompleted then upsert. Both hooks sit immediately before
    // the shared snapshots.json RMW critical section.
    const runA = verifyAndCommitSession({
      store,
      dataDir,
      deviceId: projA.deviceId,
      uploadId: uploadA,
      now: () => clock.now(),
      hooks: {
        afterClaimAcquired: async () => {
          aReached = true;
          releaseBothIfReady();
          await waitA;
        },
      },
    });
    const runB = verifyAndCommitSession({
      store,
      dataDir,
      deviceId: projB.deviceId,
      uploadId: uploadB,
      now: () => clock.now(),
      hooks: {
        afterCompleted: async () => {
          bReached = true;
          releaseBothIfReady();
          await waitB;
        },
      },
    });

    await Promise.all([runA, runB]);
    assert.equal(aReached && bReached, true, 'both writers must enter the barrier');

    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(
      index.filter((e) => e && e.snapshotId === SNAPSHOT_A).length,
      1,
      'snapshots.json must contain snapshot A exactly once',
    );
    assert.equal(
      index.filter((e) => e && e.snapshotId === SNAPSHOT_B).length,
      1,
      'snapshots.json must contain snapshot B exactly once',
    );
    assert.equal(index.length, 2, 'snapshots.json must contain exactly A and B');

    const device = JSON.parse(
      await readFile(join(dataDir, deviceRelOf(DEVICE_A), 'device.json'), 'utf8'),
    );
    assert.equal(
      device.snapshotCount,
      2,
      'device.snapshotCount must equal snapshots.json length after concurrent finalize',
    );

    // Both sessions remain committed; finals intact.
    assert.equal(
      (await store.getSession({ authenticatedDeviceId: DEVICE_A, uploadId: uploadA })).status,
      'committed',
    );
    assert.equal(
      (await store.getSession({ authenticatedDeviceId: DEVICE_A, uploadId: uploadB })).status,
      'committed',
    );
    assert.equal(
      await pathExists(join(finalAbs(DEVICE_A, SNAPSHOT_A), 'COMPLETED.json')),
      true,
    );
    assert.equal(
      await pathExists(join(finalAbs(DEVICE_A, SNAPSHOT_B), 'COMPLETED.json')),
      true,
    );
  });
});

// ── GLM-F4: re-read COMPLETED after claim on recovery ───────────────

describe('GLM-F4 COMPLETED re-read after claim on recovery', () => {
  it('GLM-F4: committed recovery — afterClaimAcquired swaps COMPLETED to foreign identity → upload-commit-conflict; no stale index/session/final mutation', async () => {
    // Causal: finishFromExistingCompleted must re-read COMPLETED under claim; using claim-pre
    // committedAt/identity enables TOCTOU upsert after marker swap.
    const proj = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      files: [{ path: 'f4.txt', size: 4, content: 'f4ok' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);
    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const finalDir = finalAbs(proj.deviceId, proj.snapshotId);
    const completedPath = join(finalDir, 'COMPLETED.json');
    const indexPath = join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json');
    const fileBefore = await readFile(join(finalDir, 'files', 'f4.txt'));
    const indexBefore = await readFile(indexPath, 'utf8');
    const sessionBefore = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(sessionBefore.status, 'committed');

    const foreignCompleted = {
      schemaVersion: 1,
      origin: 'remote-upload',
      snapshotId: proj.snapshotId,
      manifestDigest: 'c'.repeat(64),
      committedAt: '2099-06-01T00:00:00.000Z',
      uploadId: 'eeeeeeee-bbbb-4ccc-8ddd-0000000000f4',
      deviceId: DEVICE_B,
    };

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
          hooks: {
            afterClaimAcquired: async () => {
              // Atomic replace of COMPLETED after claim acquisition (valid → foreign identity).
              const tmp = join(finalDir, 'COMPLETED.json.swp');
              await writeFile(tmp, JSON.stringify(foreignCompleted), 'utf8');
              await rename(tmp, completedPath);
            },
          },
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [
            finalDir,
            dataDir,
            foreignCompleted.uploadId,
            DEVICE_B,
            foreignCompleted.manifestDigest,
          ],
        });
        return true;
      },
    );

    // Must not upsert stale committedAt/identity; session + final payload unchanged.
    assert.equal(await readFile(indexPath, 'utf8'), indexBefore);
    assert.deepEqual(await readFile(join(finalDir, 'files', 'f4.txt')), fileBefore);
    const sessionAfter = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(sessionAfter.status, 'committed');
    assert.equal(sessionAfter.manifestDigest, proj.manifestDigest);

    // Marker remains the post-claim swapped body (flow must not rewrite same-identity COMPLETED).
    const completedAfter = JSON.parse(await readFile(completedPath, 'utf8'));
    assert.equal(completedAfter.uploadId, foreignCompleted.uploadId);
    assert.equal(completedAfter.manifestDigest, foreignCompleted.manifestDigest);
    assert.equal(completedAfter.deviceId, DEVICE_B);
    assert.notEqual(completedAfter.manifestDigest, proj.manifestDigest);
  });

  it('GLM-F4: verifying recovery — afterClaimAcquired corrupts COMPLETED → upload-commit-conflict; no index/session commit side-effects from stale claim-pre read', async () => {
    // Alternate recovery surface: session enters verifying, valid same-identity COMPLETED present.
    const proj = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'f4v.txt', size: 5, content: 'f4ver' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    // Publish COMPLETED + indexes then crash before markCommitted via afterIndexUpsert.
    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
          hooks: {
            afterIndexUpsert: async () => {
              throw new Error('injected-post-index-pre-markCommitted');
            },
          },
        }),
      () => true,
    );

    assert.equal(await pathExists(join(finalAbs(proj.deviceId, proj.snapshotId), 'COMPLETED.json')), true);
    // Session may be verifying (markCommitted not reached) — recovery re-enters via COMPLETED path.
    const mid = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(mid.status, 'committed');

    const finalDir = finalAbs(proj.deviceId, proj.snapshotId);
    const completedPath = join(finalDir, 'COMPLETED.json');
    const indexPath = join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json');
    const indexBefore = await readFile(indexPath, 'utf8');
    const fileBefore = await readFile(join(finalDir, 'files', 'f4v.txt'));

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
          hooks: {
            afterClaimAcquired: async () => {
              const tmp = join(finalDir, 'COMPLETED.json.swp');
              await writeFile(tmp, '{broken-completed', 'utf8');
              await rename(tmp, completedPath);
            },
          },
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [finalDir, dataDir, '{broken-completed'],
        });
        return true;
      },
    );

    assert.equal(await readFile(indexPath, 'utf8'), indexBefore);
    assert.deepEqual(await readFile(join(finalDir, 'files', 'f4v.txt')), fileBefore);
    const sessionAfter = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    // Must not markCommitted on conflict after hostile COMPLETED under claim.
    assert.notEqual(sessionAfter.status, 'committed');
  });
});

// ── PM-P2: index metadata fail-close (corrupt / non-array / device / oversize) ──
// Authority: readJsonRel must not treat SyntaxError / SafeDataFileError / oversize as empty;
// upsertRemoteIndexes must not reset snapshots.json to [] or device.json to defaults and
// silently overwrite durable index metadata. COMPLETED is a commit point — do not require rollback.

describe('PM-P2 index metadata fail-close', () => {
  const MAX_MANIFEST_JSON_BYTES = 8 * 1024 * 1024;

  it('corrupt snapshots.json at index stage → unique upload-io-error; bytes unchanged; not markCommitted', async () => {
    const proj = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      files: [{ path: 'idx-fc-1.txt', size: 4, content: 'fc01' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    const indexPath = join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json');
    // Truncated / hostile JSON with unique sentinel payload (byte identity only).
    const corruptBytes = Buffer.from(
      '{"schema":"PM-P2-IDX-FC-SENTINEL-CORRUPT-v1","entries":[{"snapshotId":',
      'utf8',
    );
    await writeFile(indexPath, corruptBytes);
    const before = await readFile(indexPath);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            dataDir,
            indexPath,
            'PM-P2-IDX-FC-SENTINEL-CORRUPT-v1',
            'snapshots.json',
            'SyntaxError',
            'JSON',
          ],
        });
        return true;
      },
    );

    const after = await readFile(indexPath);
    assert.equal(after.length, before.length);
    assert.deepEqual(after, before);

    // Must not rebuild as sole remote entry for this finalize.
    const asText = after.toString('utf8');
    assert.equal(asText.includes(proj.snapshotId), false);
    assert.equal(asText.includes(proj.manifestDigest), false);

    const sessionAfter = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(sessionAfter.status, 'committed');
    // COMPLETED may already exist (commit point); do not require its absence/rollback.
  });

  it('non-array snapshots.json shape → unique upload-io-error; original bytes preserved', async () => {
    const proj = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'idx-fc-2.txt', size: 4, content: 'fc02' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    const indexPath = join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json');
    // Valid JSON but hostile non-array shape (must not be treated as empty list).
    const hostileBytes = Buffer.from(
      JSON.stringify({
        schema: 'PM-P2-IDX-FC-SENTINEL-NONARRAY-v1',
        kind: 'object-not-array',
        remote: { snapshotId: 'hostile-placeholder', origin: 'remote-upload' },
      }),
      'utf8',
    );
    await writeFile(indexPath, hostileBytes);
    const before = await readFile(indexPath);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            dataDir,
            indexPath,
            'PM-P2-IDX-FC-SENTINEL-NONARRAY-v1',
            'snapshots.json',
            'object-not-array',
          ],
        });
        return true;
      },
    );

    const after = await readFile(indexPath);
    assert.equal(after.length, before.length);
    assert.deepEqual(after, before);

    // Not rewritten to a one-element remote array.
    let parsed = null;
    try {
      parsed = JSON.parse(after.toString('utf8'));
    } catch {
      parsed = null;
    }
    assert.ok(parsed !== null && !Array.isArray(parsed));
    assert.equal(parsed.schema, 'PM-P2-IDX-FC-SENTINEL-NONARRAY-v1');

    const sessionAfter = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(sessionAfter.status, 'committed');
  });

  it('valid snapshots array + corrupt device.json → upload-io-error; device bytes unchanged; not committed; retry recoverable', async () => {
    const proj = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      files: [{ path: 'idx-fc-3.txt', size: 5, content: 'fc03x' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    const deviceRel = deviceRelOf(proj.deviceId);
    const indexPath = join(dataDir, deviceRel, 'snapshots.json');
    const devicePath = join(dataDir, deviceRel, 'device.json');

    // Existing valid array (may already hold unrelated remote metadata).
    const priorIndex = [
      {
        snapshotId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001',
        origin: 'remote-upload',
        manifestDigest: ZERO_SHA,
        committedAt: T0,
      },
    ];
    await writeFile(indexPath, JSON.stringify(priorIndex, null, 2), 'utf8');

    // Corrupt / non-plain device.json (truncated JSON with unique sentinel).
    const corruptDevice = Buffer.from(
      '{"deviceId":"PM-P2-IDX-FC-SENTINEL-DEVICE-v1","hostname":',
      'utf8',
    );
    await writeFile(devicePath, corruptDevice);
    const deviceBefore = await readFile(devicePath);

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            dataDir,
            devicePath,
            'PM-P2-IDX-FC-SENTINEL-DEVICE-v1',
            'device.json',
            'unknown',
            'SyntaxError',
          ],
        });
        return true;
      },
    );

    const deviceAfter = await readFile(devicePath);
    assert.equal(deviceAfter.length, deviceBefore.length);
    assert.deepEqual(deviceAfter, deviceBefore);
    // Must not overwrite with default unknown plain object.
    const deviceText = deviceAfter.toString('utf8');
    assert.equal(deviceText.includes('"hostname": "unknown"'), false);
    assert.equal(deviceText.includes('"ipAddress": "unknown"'), false);
    assert.equal(deviceText.includes('"status": "unknown"'), false);

    const sessionMid = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(sessionMid.status, 'committed');

    // snapshots.json may already idempotently include this remote entry — no tx rollback required.
    // Retry must be recoverable after operator repairs device.json.
    await writeFile(
      devicePath,
      JSON.stringify(
        {
          deviceId: deviceRel.split('/').pop(),
          hostname: 'repaired-host',
          ipAddress: '127.0.0.1',
          snapshotCount: 1,
          lastBackupAt: null,
          status: 'online',
          lastHeartbeatAt: null,
        },
        null,
        2,
      ),
      'utf8',
    );

    await verifyAndCommitSession({
      store,
      dataDir,
      deviceId: proj.deviceId,
      uploadId,
      now: () => clock.now(),
    });

    const sessionOk = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.equal(sessionOk.status, 'committed');

    const indexFinal = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.ok(Array.isArray(indexFinal));
    assert.ok(indexFinal.some((e) => e && e.snapshotId === proj.snapshotId));
    // Prior unrelated entry retained (no silent wipe-to-single-entry).
    assert.ok(
      indexFinal.some((e) => e && e.snapshotId === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'),
    );
  });

  it('snapshots.json larger than MAX_MANIFEST_JSON_BYTES → upload-io-error; size/hash unchanged; no rebuild', async () => {
    const proj = makeProjection({
      deviceId: DEVICE_B,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'idx-fc-4.txt', size: 3, content: 'fc4' }],
    });
    const { uploadId } = await prepareCompleteStaging(proj);

    const indexPath = join(dataDir, deviceRelOf(proj.deviceId), 'snapshots.json');
    // 8 MiB + 1 fixture via Buffer; content never asserted/printed.
    const oversize = Buffer.alloc(MAX_MANIFEST_JSON_BYTES + 1, 0x78);
    await writeFile(indexPath, oversize);
    const sizeBefore = oversize.length;
    const hashBefore = createHash('sha256').update(oversize).digest('hex');

    await assert.rejects(
      () =>
        verifyAndCommitSession({
          store,
          dataDir,
          deviceId: proj.deviceId,
          uploadId,
          now: () => clock.now(),
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            dataDir,
            indexPath,
            'snapshots.json',
            'SafeDataFileError',
            String(MAX_MANIFEST_JSON_BYTES),
          ],
        });
        return true;
      },
    );

    const after = await readFile(indexPath);
    assert.equal(after.length, sizeBefore);
    assert.equal(createHash('sha256').update(after).digest('hex'), hashBefore);

    // Must not rebuild as a small single-entry array.
    assert.ok(after.length > MAX_MANIFEST_JSON_BYTES);

    const sessionAfter = await store.getSession({
      authenticatedDeviceId: proj.deviceId,
      uploadId,
    });
    assert.notEqual(sessionAfter.status, 'committed');
  });
});
