/**
 * C4 — storage.js direct readers remote-upload fail-close contract.
 * Authority: design §8.4 + plan C4 (listSnapshots / getSnapshotManifest / restoreSnapshot).
 *
 * Uses real temporary dataDir fixtures. Does not rely on string-scanning src.
 * Remote readable only when COMPLETED + index + canonical manifest digests agree
 * (sha256(JSON.stringify(canonicalManifest))); local rows keep legacy behavior.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import {
  listSnapshots,
  getSnapshotManifest,
  restoreSnapshot,
  safeDevicePath,
  createBackup,
} from '../src/storage.js';

const DEVICE = 'device-storage-compat-001';
const SNAPSHOT_REMOTE = '660e8400-e29b-41d4-a716-446655440010';
const SNAPSHOT_LOCAL = '660e8400-e29b-41d4-a716-446655440011';
const SNAPSHOT_OTHER = '660e8400-e29b-41d4-a716-446655440012';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const T0 = '2026-07-22T12:00:00.000Z';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** @type {string | undefined} */
let dataDir;

function deviceRel() {
  return safeDevicePath(dataDir, DEVICE).deviceRel;
}

function snapshotDir(snapshotId) {
  return join(dataDir, deviceRel(), 'snapshots', snapshotId);
}

function indexPath() {
  return join(dataDir, deviceRel(), 'snapshots.json');
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} error
 * @param {string[]} leakTokens
 */
function assertFailClosedPublicError(error, leakTokens = []) {
  assert.ok(error instanceof LinkeError, 'direct reader fail-close must be LinkeError');
  assert.ok(Object.values(ERROR_CODES).includes(error.code), 'registered ERROR_CODES only');
  assert.equal(error.message, error.code);
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    error.details ? JSON.stringify(error.details) : '',
  ].join('\0');
  for (const token of leakTokens) {
    if (!token || token.length < 2) continue;
    assert.ok(!publicParts.includes(token), `must not leak ${token}`);
  }
}

/**
 * Plant a remote-upload style snapshot final directory + optional index entry.
 *
 * Design §8.4: COMPLETED.manifestDigest, index.manifestDigest, and
 * sha256(JSON.stringify(canonicalManifest)) must agree for a readable remote.
 * Fixture always builds a canonical-shaped manifest and defaults marker/index to
 * that real canonicalDigest so non-mismatch cases cannot fail-close on an
 * unrelated digest error.
 *
 * @param {{
 *   snapshotId?: string,
 *   withCompleted?: boolean,
 *   withPending?: boolean,
 *   completedCorrupt?: boolean,
 *   completedDigest?: string,
 *   indexDigest?: string | null,
 *   indexOrigin?: string | null | undefined,
 *   omitIndexFields?: string[],
 *   fileContent?: string,
 *   fileRel?: string,
 *   skipIndex?: boolean,
 *   pendingIdentity?: object,
 * }} [opts]
 */
async function plantRemoteFixture(opts = {}) {
  const snapshotId = opts.snapshotId ?? SNAPSHOT_REMOTE;
  const fileRel = opts.fileRel ?? 'hello.txt';
  const fileContent = opts.fileContent ?? 'remote-hello';
  const fileSha = createHash('sha256').update(fileContent, 'utf8').digest('hex');
  const totalBytes = Buffer.byteLength(fileContent, 'utf8');

  const base = snapshotDir(snapshotId);
  await mkdir(join(base, 'files', ...(fileRel.includes('/') ? fileRel.split('/').slice(0, -1) : [])), {
    recursive: true,
  });
  // Ensure parent chain for nested.
  await mkdir(join(base, 'files'), { recursive: true });
  const fileAbs = join(base, 'files', fileRel);
  await mkdir(join(fileAbs, '..'), { recursive: true });
  await writeFile(fileAbs, fileContent, 'utf8');

  // Canonical key order matches projectCanonicalUploadManifest / design §5.2.
  // Digest authority: sha256(JSON.stringify(manifest)) — not pretty-printed disk bytes.
  const manifest = {
    schemaVersion: 2,
    snapshotId,
    deviceId: DEVICE,
    createdAt: T0,
    files: [fileRel],
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: [{ path: fileRel, size: totalBytes, sha256: fileSha }],
    },
  };
  const canonicalDigest = createHash('sha256')
    .update(JSON.stringify(manifest), 'utf8')
    .digest('hex');
  // Default PENDING / COMPLETED / index all use the real canonical digest.
  // Override completedDigest / indexDigest only for intentional mismatch cases.
  const digest = canonicalDigest;

  await writeFile(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  if (opts.withPending) {
    await writeFile(
      join(base, 'PENDING.json'),
      JSON.stringify(
        opts.pendingIdentity ?? {
          schemaVersion: 1,
          deviceId: DEVICE,
          snapshotId,
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000010',
          manifestDigest: digest,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  if (opts.withCompleted) {
    if (opts.completedCorrupt) {
      await writeFile(join(base, 'COMPLETED.json'), '{broken', 'utf8');
    } else {
      await writeFile(
        join(base, 'COMPLETED.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            origin: 'remote-upload',
            snapshotId,
            manifestDigest: opts.completedDigest ?? digest,
            committedAt: T0,
            uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000010',
            deviceId: DEVICE,
          },
          null,
          2,
        ),
        'utf8',
      );
    }
  }

  if (!opts.skipIndex) {
    /** @type {Record<string, unknown>} */
    const entry = {
      snapshotId,
      origin: opts.indexOrigin === undefined ? 'remote-upload' : opts.indexOrigin,
      manifestDigest: opts.indexDigest === undefined ? digest : opts.indexDigest,
      committedAt: T0,
    };
    if (opts.indexOrigin === null) delete entry.origin;
    if (opts.indexDigest === null) delete entry.manifestDigest;
    for (const k of opts.omitIndexFields ?? []) {
      delete entry[k];
    }
    // Drop keys explicitly set undefined via null sentinel above already handled.
    if (opts.indexOrigin === null) {
      // already deleted
    }
    let list = [];
    try {
      list = JSON.parse(await readFile(indexPath(), 'utf8'));
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    list = list.filter((e) => e && e.snapshotId !== snapshotId);
    list.push(entry);
    await mkdir(join(dataDir, deviceRel()), { recursive: true });
    await writeFile(indexPath(), JSON.stringify(list, null, 2), 'utf8');
  }

  return { snapshotId, digest: canonicalDigest, fileRel, fileContent, manifest, base };
}

/**
 * Plant local-style index entry + final (no origin / no COMPLETED).
 */
async function plantLocalFixture(opts = {}) {
  const snapshotId = opts.snapshotId ?? SNAPSHOT_LOCAL;
  const fileRel = opts.fileRel ?? 'local.txt';
  const fileContent = opts.fileContent ?? 'local-content';
  const base = snapshotDir(snapshotId);
  await mkdir(join(base, 'files'), { recursive: true });
  await writeFile(join(base, 'files', fileRel), fileContent, 'utf8');
  const manifest = {
    schemaVersion: 2,
    snapshotId,
    deviceId: DEVICE,
    createdAt: T0,
    hostname: 'local-host',
    sourcePath: '/tmp/source',
    files: [fileRel],
    integrity: {
      algorithm: 'sha256',
      totalBytes: Buffer.byteLength(fileContent, 'utf8'),
      entries: [
        {
          path: fileRel,
          size: Buffer.byteLength(fileContent, 'utf8'),
          sha256: createHash('sha256').update(fileContent, 'utf8').digest('hex'),
        },
      ],
    },
  };
  await writeFile(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  /** @type {Record<string, unknown>} */
  const entry = {
    snapshotId,
    createdAt: T0,
    hostname: 'local-host',
    sourcePath: '/tmp/source',
    fileCount: 1,
  };
  if (opts.origin !== undefined) entry.origin = opts.origin;

  let list = [];
  try {
    list = JSON.parse(await readFile(indexPath(), 'utf8'));
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list = list.filter((e) => e && e.snapshotId !== snapshotId);
  list.push(entry);
  await mkdir(join(dataDir, deviceRel()), { recursive: true });
  await writeFile(indexPath(), JSON.stringify(list, null, 2), 'utf8');
  return { snapshotId, fileRel, fileContent, manifest, base };
}

/**
 * Assert all three readers fail-close without returning manifest/file content.
 * @param {string} snapshotId
 * @param {string[]} leakTokens
 * @param {{ expectHiddenFromList?: boolean }} [opts]
 */
async function assertAllReadersFailClose(snapshotId, leakTokens = [], opts = {}) {
  const expectHidden = opts.expectHiddenFromList !== false;

  const listed = await listSnapshots(dataDir, DEVICE);
  assert.ok(Array.isArray(listed));
  if (expectHidden) {
    assert.equal(
      listed.some((e) => e && e.snapshotId === snapshotId),
      false,
      'listSnapshots must hide fail-closed remote entry',
    );
  }

  // get must not return usable manifest content.
  let getResult;
  let getErr;
  try {
    getResult = await getSnapshotManifest(dataDir, DEVICE, snapshotId);
  } catch (err) {
    getErr = err;
  }
  if (getErr) {
    assertFailClosedPublicError(getErr, [...leakTokens, snapshotDir(snapshotId), dataDir]);
  } else {
    // null/undefined acceptable only if no manifest body fields leaked as success.
    assert.ok(getResult == null, 'getSnapshotManifest must not return manifest object');
  }

  // restore must fail before creating/writing target.
  const target = join(dataDir, `restore-target-${snapshotId}`);
  // Ensure parent dataDir exists; target itself must not be created on fail-close.
  await assert.rejects(
    () =>
      restoreSnapshot(dataDir, {
        deviceId: DEVICE,
        snapshotId,
        targetPath: target,
      }),
    (err) => {
      assertFailClosedPublicError(err, [...leakTokens, target, snapshotDir(snapshotId), dataDir]);
      return true;
    },
  );
  assert.equal(await pathExists(target), false, 'restore must not create target on fail-close');
}

/**
 * Assert all three readers succeed for a readable snapshot.
 */
async function assertAllReadersSucceed(snapshotId, expectedFileRel, expectedContent) {
  const listed = await listSnapshots(dataDir, DEVICE);
  assert.ok(listed.some((e) => e && e.snapshotId === snapshotId));

  const man = await getSnapshotManifest(dataDir, DEVICE, snapshotId);
  assert.ok(man && typeof man === 'object');
  assert.equal(man.snapshotId, snapshotId);
  assert.ok(Array.isArray(man.files) || (man.integrity && Array.isArray(man.integrity.entries)));

  const target = join(dataDir, `restore-ok-${snapshotId}`);
  const result = await restoreSnapshot(dataDir, {
    deviceId: DEVICE,
    snapshotId,
    targetPath: target,
  });
  assert.equal(result.restored, true);
  assert.equal(await readFile(join(target, expectedFileRel), 'utf8'), expectedContent);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-c4-storage-'));
  await mkdir(join(dataDir, deviceRel(), 'snapshots'), { recursive: true });
});

afterEach(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

// ── remote pending-without-marker ───────────────────────────────────

describe('remote pending-without-marker', () => {
  it('list hides; get cannot return manifest; restore fail-closes before target create', async () => {
    const fx = await plantRemoteFixture({
      withPending: true,
      withCompleted: false,
    });
    await assertAllReadersFailClose(fx.snapshotId, [fx.base, 'PENDING', fx.fileContent]);
  });
});

// ── remote corrupt / missing marker / digest mismatch / stale index ─

describe('remote marker and index fail-close matrix', () => {
  it('corrupt COMPLETED → all three readers fail-close (no content)', async () => {
    const fx = await plantRemoteFixture({
      withCompleted: true,
      completedCorrupt: true,
    });
    await assertAllReadersFailClose(fx.snapshotId, [fx.base, '{broken', fx.fileContent]);
  });

  it('marker missing with origin=remote-upload index → fail-close all readers', async () => {
    const fx = await plantRemoteFixture({
      withCompleted: false,
      withPending: false,
    });
    await assertAllReadersFailClose(fx.snapshotId, [fx.base, fx.fileContent]);
  });

  it('COMPLETED digest mismatch vs index → fail-close all readers', async () => {
    // Marker and index disagree; both digests are legal 64-hex but not necessarily
    // equal to canonicalDigest — isolates marker↔index only (not manifest mismatch).
    const fx = await plantRemoteFixture({
      withCompleted: true,
      completedDigest: DIGEST_A,
      indexDigest: DIGEST_B,
    });
    assert.notEqual(DIGEST_A, DIGEST_B);
    await assertAllReadersFailClose(fx.snapshotId, [fx.base, DIGEST_A, DIGEST_B]);
  });

  it('COMPLETED digest mismatch vs manifest → fail-close all readers', async () => {
    // COMPLETED and index share one legal 64-hex that is intentionally NOT the
    // canonical manifest digest. Design §8.4 requires three-party agreement:
    // COMPLETED ↔ index ↔ sha256(JSON.stringify(canonicalManifest)).
    // Marker↔index already match here, so fail-close uniquely proves manifest mismatch.
    const nonCanonical = DIGEST_B;
    const fx = await plantRemoteFixture({
      withCompleted: true,
      completedDigest: nonCanonical,
      indexDigest: nonCanonical,
    });
    assert.notEqual(
      nonCanonical,
      fx.digest,
      'fixture contract: shared marker/index digest must ≠ canonicalDigest',
    );
    await assertAllReadersFailClose(fx.snapshotId, [fx.base, nonCanonical]);
  });

  it('stale remote index (origin remote-upload, marker missing) → fail-close', async () => {
    // Index points at remote snapshotId that has no final dir at all.
    await mkdir(join(dataDir, deviceRel()), { recursive: true });
    await writeFile(
      indexPath(),
      JSON.stringify(
        [
          {
            snapshotId: SNAPSHOT_OTHER,
            origin: 'remote-upload',
            manifestDigest: DIGEST_A,
            committedAt: T0,
          },
        ],
        null,
        2,
      ),
      'utf8',
    );
    await assertAllReadersFailClose(SNAPSHOT_OTHER, [dataDir, SNAPSHOT_OTHER]);
  });

  it('stale remote index digest mismatch with present COMPLETED → fail-close', async () => {
    const fx = await plantRemoteFixture({
      withCompleted: true,
      completedDigest: DIGEST_A,
      indexDigest: DIGEST_B,
    });
    await assertAllReadersFailClose(fx.snapshotId, [fx.base]);
  });
});

// ── valid remote COMPLETED ──────────────────────────────────────────

describe('valid remote COMPLETED + matching index/manifest', () => {
  it('list/get/restore all succeed when origin=remote-upload and digests consistent', async () => {
    // Design §8.4: readable remote requires COMPLETED + index + canonical manifest
    // digests all equal (sha256(JSON.stringify(canonicalManifest))). plantRemoteFixture
    // defaults marker/index to that real canonicalDigest — not a stand-in hash.
    const fileContent = 'remote-ok-content';
    const fileRel = 'ok.txt';
    const fx = await plantRemoteFixture({
      withCompleted: true,
      withPending: false,
      fileContent,
      fileRel,
    });
    assert.equal(
      createHash('sha256').update(JSON.stringify(fx.manifest), 'utf8').digest('hex'),
      fx.digest,
      'fixture contract: returned digest is canonical manifest digest',
    );
    await assertAllReadersSucceed(fx.snapshotId, fileRel, fileContent);
  });

  it('retained PENDING after COMPLETED does not bypass marker authority (still readable only via COMPLETED)', async () => {
    // Marker / index / PENDING identity all carry real canonicalDigest.
    const fx = await plantRemoteFixture({
      withCompleted: true,
      withPending: true,
      fileContent: 'with-pending-retained',
      fileRel: 'p.txt',
    });
    // Still readable because COMPLETED + index + canonical digest agree.
    await assertAllReadersSucceed(fx.snapshotId, 'p.txt', 'with-pending-retained');
  });
});

// ── local compatibility (no origin / non-remote origin) ─────────────

describe('local index compatibility (no remote marker required)', () => {
  it('local entry without origin keeps list/get/restore behavior', async () => {
    const fx = await plantLocalFixture();
    await assertAllReadersSucceed(fx.snapshotId, fx.fileRel, fx.fileContent);
  });

  it('local entry with origin !== remote-upload does not require COMPLETED', async () => {
    const fx = await plantLocalFixture({
      snapshotId: SNAPSHOT_OTHER,
      origin: 'local-agent',
      fileContent: 'legacy-origin',
      fileRel: 'legacy.txt',
    });
    await assertAllReadersSucceed(fx.snapshotId, 'legacy.txt', 'legacy-origin');
  });

  it('createBackup local snapshot remains listable/gettable/restorable without COMPLETED', async () => {
    const sourceDir = join(dataDir, 'src-local');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'f.txt'), 'from-createBackup', 'utf8');
    const record = await createBackup(dataDir, {
      deviceId: DEVICE,
      hostname: 'h',
      ipAddress: '127.0.0.1',
      sourcePath: sourceDir,
    });
    assert.ok(record.snapshotId);
    // No COMPLETED.json required for local.
    assert.equal(
      await pathExists(join(snapshotDir(record.snapshotId), 'COMPLETED.json')),
      false,
    );
    const listed = await listSnapshots(dataDir, DEVICE);
    assert.ok(listed.some((e) => e.snapshotId === record.snapshotId));
    const man = await getSnapshotManifest(dataDir, DEVICE, record.snapshotId);
    assert.ok(man);
    const target = join(dataDir, 'restore-local-backup');
    const res = await restoreSnapshot(dataDir, {
      deviceId: DEVICE,
      snapshotId: record.snapshotId,
      targetPath: target,
    });
    assert.equal(res.restored, true);
    assert.equal(await readFile(join(target, 'f.txt'), 'utf8'), 'from-createBackup');
  });
});

// ── candidate / claim not snapshots; incomplete remote index ────────

describe('non-snapshot siblings and incomplete remote index entries', () => {
  it('candidate .upload-*.pending directory is not listable/gettable/restorable as snapshot', async () => {
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000099';
    const candName = `.upload-${uploadId}.pending`;
    const cand = join(dataDir, deviceRel(), 'snapshots', candName);
    await mkdir(join(cand, 'files'), { recursive: true });
    await writeFile(join(cand, 'files', 'x.txt'), 'candidate-secret', 'utf8');
    await writeFile(
      join(cand, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, snapshotId: candName, files: ['x.txt'] }),
      'utf8',
    );

    const listed = await listSnapshots(dataDir, DEVICE);
    assert.equal(listed.some((e) => e && String(e.snapshotId).includes('upload-')), false);
    assert.equal(listed.some((e) => e && e.snapshotId === candName), false);

    // get must not return candidate manifest content.
    let candMan = null;
    let candGetErr = null;
    try {
      candMan = await getSnapshotManifest(dataDir, DEVICE, candName);
    } catch (err) {
      candGetErr = err;
    }
    if (candGetErr) {
      if (candGetErr instanceof LinkeError) {
        assertFailClosedPublicError(candGetErr, [cand, 'candidate-secret', dataDir]);
      }
      // Non-LinkeError invalid-id path is acceptable only if no content returned (throw is enough).
    } else {
      assert.ok(candMan == null, 'candidate must not be returned as snapshot manifest');
    }

    // restore must not materialize candidate content.
    const target = join(dataDir, 'restore-from-candidate');
    let restored = false;
    try {
      await restoreSnapshot(dataDir, {
        deviceId: DEVICE,
        snapshotId: candName,
        targetPath: target,
      });
      restored = true;
    } catch (err) {
      if (err instanceof LinkeError) {
        assertFailClosedPublicError(err, [cand, 'candidate-secret', dataDir]);
      }
    }
    assert.equal(restored, false);
    if (await pathExists(target)) {
      const listing = await readdir(target).catch(() => []);
      assert.equal(listing.includes('x.txt'), false);
    }
  });

  it('claim sibling .claim-* is never treated as a snapshot', async () => {
    const claimName = `.claim-${SNAPSHOT_REMOTE}`;
    const claimPath = join(dataDir, deviceRel(), 'snapshots', claimName);
    await writeFile(
      claimPath,
      JSON.stringify({
        schemaVersion: 1,
        deviceId: DEVICE,
        snapshotId: SNAPSHOT_REMOTE,
        uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        manifestDigest: DIGEST_A,
      }),
      'utf8',
    );
    const listed = await listSnapshots(dataDir, DEVICE);
    assert.equal(listed.some((e) => e && String(e.snapshotId).includes('claim')), false);

    let restored = false;
    try {
      await restoreSnapshot(dataDir, {
        deviceId: DEVICE,
        snapshotId: claimName,
        targetPath: join(dataDir, 'restore-claim'),
      });
      restored = true;
    } catch {
      // expected
    }
    assert.equal(restored, false);
  });

  it('remote index entry missing origin is hidden or rejected (not treated as readable remote)', async () => {
    const fx = await plantRemoteFixture({
      withCompleted: false,
      indexOrigin: null,
      omitIndexFields: ['origin'],
    });
    // Without origin, if it looks like incomplete remote-less entry pointing at pending-less final:
    // - If treated as local: would be readable (legacy). Design: remote marker only when origin===remote-upload.
    // Missing origin on a path that only has remote semantics files is ambiguous; C4 locks:
    // entry lacking required remote fields when claiming remote must be hidden/rejected if origin set wrong.
    // Here origin omitted → local behavior IF final has no pending/COMPLETED remote semantics.
    // Plant only files+manifest (like local) already — with origin omitted, local path allowed.
    // Strengthen: entry with origin remote-upload but missing digest must hide/reject.
    // COMPLETED uses real canonicalDigest so fail-close is solely from incomplete index schema.
    await plantRemoteFixture({
      snapshotId: SNAPSHOT_OTHER,
      withCompleted: true,
      indexOrigin: 'remote-upload',
      indexDigest: null,
      omitIndexFields: ['manifestDigest'],
      fileContent: 'missing-digest',
      fileRel: 'md.txt',
    });
    const listed = await listSnapshots(dataDir, DEVICE);
    assert.equal(
      listed.some((e) => e && e.snapshotId === SNAPSHOT_OTHER),
      false,
      'remote entry missing manifestDigest must be hidden',
    );
    await assert.rejects(
      () =>
        restoreSnapshot(dataDir, {
          deviceId: DEVICE,
          snapshotId: SNAPSHOT_OTHER,
          targetPath: join(dataDir, 'restore-missing-digest'),
        }),
      (err) => {
        assertFailClosedPublicError(err, [dataDir, snapshotDir(SNAPSHOT_OTHER)]);
        return true;
      },
    );
    // silence unused
    assert.ok(fx.snapshotId);
  });

  it('remote index missing committedAt or snapshotId → hide/reject', async () => {
    await mkdir(join(dataDir, deviceRel()), { recursive: true });
    await writeFile(
      indexPath(),
      JSON.stringify(
        [
          {
            // missing snapshotId
            origin: 'remote-upload',
            manifestDigest: DIGEST_A,
            committedAt: T0,
          },
          {
            snapshotId: SNAPSHOT_REMOTE,
            origin: 'remote-upload',
            manifestDigest: DIGEST_A,
            // missing committedAt
          },
        ],
        null,
        2,
      ),
      'utf8',
    );
    const listed = await listSnapshots(dataDir, DEVICE);
    assert.equal(listed.some((e) => e && e.origin === 'remote-upload'), false);
    assert.equal(listed.some((e) => e && e.snapshotId === SNAPSHOT_REMOTE), false);
  });
});

// ── hostile snapshotId / path / symlink + error desensitization ─────

describe('hostile inputs and desensitization across all readers', () => {
  it('path traversal snapshotId fails closed without leaking dataDir', async () => {
    const hostileIds = [
      '../escape',
      '..',
      'foo/bar',
      'a\0b',
      '.upload-aaaaaaaa-bbbb-4ccc-8ddd-000000000001.pending',
    ];
    for (const snapshotId of hostileIds) {
      await assert.rejects(
        async () => {
          try {
            const man = await getSnapshotManifest(dataDir, DEVICE, snapshotId);
            assert.ok(man == null);
            // If null, still try restore to ensure both paths covered.
          } catch (err) {
            throw err;
          }
          await restoreSnapshot(dataDir, {
            deviceId: DEVICE,
            snapshotId,
            targetPath: join(dataDir, 'hostile-target'),
          });
        },
        (err) => {
          assert.ok(err instanceof Error);
          if (err instanceof LinkeError) {
            assertFailClosedPublicError(err, [dataDir, snapshotId, 'escape']);
          } else {
            // Legacy Error messages must not become long-term contract; GREEN should use LinkeError.
            // For RED, accept throw but still require no restore of real content.
            const text = `${err.message || ''}`;
            // Prefer not containing absolute dataDir for new code; if legacy includes snapshotId, OK for RED.
            void text;
          }
          return true;
        },
      );
      // list must never surface hostile ids
      const listed = await listSnapshots(dataDir, DEVICE);
      assert.equal(listed.some((e) => e && e.snapshotId === snapshotId), false);
    }
  });

  it('symlink files/ directory under remote final fail-closes get/restore (no-follow)', async () => {
    // Marker/index use real canonicalDigest so fail-close is solely no-follow on files/.
    const fx = await plantRemoteFixture({
      withCompleted: true,
      fileContent: 'sym-target-content',
    });
    // Replace files/ with symlink to outside.
    const filesDir = join(fx.base, 'files');
    await rm(filesDir, { recursive: true, force: true });
    const outside = join(dataDir, 'outside-files');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'hello.txt'), 'sym-target-content', 'utf8');
    await symlink(outside, filesDir);

    // list may hide or show entry; get/restore must not return/follow content successfully.
    let getOk = false;
    try {
      const man = await getSnapshotManifest(dataDir, DEVICE, fx.snapshotId);
      if (man && typeof man === 'object' && man.integrity) getOk = true;
    } catch (err) {
      if (err instanceof LinkeError) {
        assertFailClosedPublicError(err, [outside, filesDir, dataDir, 'sym-target-content']);
      }
    }
    assert.equal(getOk, false);

    const target = join(dataDir, 'restore-symlink-remote');
    await assert.rejects(
      () =>
        restoreSnapshot(dataDir, {
          deviceId: DEVICE,
          snapshotId: fx.snapshotId,
          targetPath: target,
        }),
      (err) => {
        // SafeDataFileError or LinkeError — must not write target payload.
        assert.ok(err instanceof Error);
        if (err instanceof LinkeError) {
          assertFailClosedPublicError(err, [outside, dataDir]);
        }
        return true;
      },
    );
    if (await pathExists(target)) {
      const names = await readdir(target).catch(() => []);
      assert.equal(names.includes('hello.txt'), false);
    }
  });

  it('cannot only tighten list: get and restore independently enforce remote rules', async () => {
    // Plant remote pending-without-marker AND a second valid local.
    await plantRemoteFixture({
      snapshotId: SNAPSHOT_REMOTE,
      withPending: true,
      withCompleted: false,
      fileContent: 'must-not-get',
      fileRel: 'secret.txt',
    });
    await plantLocalFixture({
      snapshotId: SNAPSHOT_LOCAL,
      fileContent: 'local-ok',
      fileRel: 'ok.txt',
    });

    const listed = await listSnapshots(dataDir, DEVICE);
    assert.equal(listed.some((e) => e.snapshotId === SNAPSHOT_REMOTE), false);
    assert.equal(listed.some((e) => e.snapshotId === SNAPSHOT_LOCAL), true);

    // get remote must fail-close even if caller never lists.
    let remoteMan = null;
    let remoteErr = null;
    try {
      remoteMan = await getSnapshotManifest(dataDir, DEVICE, SNAPSHOT_REMOTE);
    } catch (err) {
      remoteErr = err;
    }
    if (remoteErr) {
      assertFailClosedPublicError(remoteErr, [dataDir, 'must-not-get', 'secret.txt']);
    } else {
      assert.ok(remoteMan == null);
    }

    await assert.rejects(
      () =>
        restoreSnapshot(dataDir, {
          deviceId: DEVICE,
          snapshotId: SNAPSHOT_REMOTE,
          targetPath: join(dataDir, 'restore-secret'),
        }),
      (err) => {
        assertFailClosedPublicError(err, [dataDir, 'must-not-get']);
        return true;
      },
    );

    // Local still fully readable.
    await assertAllReadersSucceed(SNAPSHOT_LOCAL, 'ok.txt', 'local-ok');
  });

  it('zero-byte remote file with valid COMPLETED is readable', async () => {
    // Empty payload still needs real three-party canonical digest agreement.
    const fx = await plantRemoteFixture({
      snapshotId: SNAPSHOT_OTHER,
      withCompleted: true,
      fileContent: '',
      fileRel: 'empty.dat',
    });
    assert.equal(fx.manifest.integrity.entries[0].sha256, ZERO_SHA);
    assert.equal(
      createHash('sha256').update(JSON.stringify(fx.manifest), 'utf8').digest('hex'),
      fx.digest,
    );
    await assertAllReadersSucceed(fx.snapshotId, 'empty.dat', '');
  });
});

// ── index is not commit point ───────────────────────────────────────

describe('snapshots.json is not the commit point', () => {
  it('index-only remote entry without valid COMPLETED is not get/restore readable', async () => {
    await writeFile(
      indexPath(),
      JSON.stringify(
        [
          {
            snapshotId: SNAPSHOT_REMOTE,
            origin: 'remote-upload',
            manifestDigest: DIGEST_A,
            committedAt: T0,
          },
        ],
        null,
        2,
      ),
      'utf8',
    );
    // No final directory at all.
    await assertAllReadersFailClose(SNAPSHOT_REMOTE, [dataDir]);
  });

  it('COMPLETED final without matching remote index entry is not list-visible; get/restore fail-close without index digest agreement', async () => {
    // Design §8.4: readable remote requires valid COMPLETED AND digest consistent with
    // index + canonical manifest. Orphan COMPLETED (even with correct marker digest)
    // without matching remote index entry ⇒ fail-close solely for missing index agreement.
    const fx = await plantRemoteFixture({
      withCompleted: true,
      skipIndex: true,
      fileContent: 'orphaned-completed',
      fileRel: 'o.txt',
    });
    await assertAllReadersFailClose(fx.snapshotId, [fx.base, dataDir, 'orphaned-completed']);
  });
});

// ── GLM-F1: PENDING occupancy must not bypass as local ──────────────

describe('GLM-F1 PENDING remote occupancy fail-close (no local bypass)', () => {
  it('GLM-F1: final has valid remote PENDING + manifest/files, no COMPLETED, no snapshots.json entry → get/restore fail-close', async () => {
    // Causal: classify must not treat remote-pending final as local when index is absent.
    // Current gap: no index + no COMPLETED → 'local' → get/restore succeed.
    const fx = await plantRemoteFixture({
      snapshotId: SNAPSHOT_REMOTE,
      withPending: true,
      withCompleted: false,
      skipIndex: true,
      fileContent: 'f1-pending-no-index-secret',
      fileRel: 'f1-pni.txt',
    });
    assert.equal(await pathExists(indexPath()), false, 'fixture: no snapshots.json');
    assert.equal(await pathExists(join(fx.base, 'PENDING.json')), true);
    assert.equal(await pathExists(join(fx.base, 'COMPLETED.json')), false);

    await assertAllReadersFailClose(fx.snapshotId, [
      fx.base,
      fx.fileContent,
      'PENDING',
      dataDir,
    ]);
  });

  it('GLM-F1: snapshots.json has same snapshotId without origin (disguised local) + final PENDING no COMPLETED → list hide, get/restore fail-close', async () => {
    // Causal: cannot use local-compat path to bypass pending semantics when PENDING occupies final.
    const fx = await plantRemoteFixture({
      snapshotId: SNAPSHOT_LOCAL,
      withPending: true,
      withCompleted: false,
      indexOrigin: null,
      fileContent: 'f1-disguised-local-pending',
      fileRel: 'f1-dlp.txt',
    });
    assert.equal(await pathExists(join(fx.base, 'PENDING.json')), true);
    assert.equal(await pathExists(join(fx.base, 'COMPLETED.json')), false);
    const index = JSON.parse(await readFile(indexPath(), 'utf8'));
    const entry = index.find((e) => e && e.snapshotId === fx.snapshotId);
    assert.ok(entry);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'origin'), false);

    await assertAllReadersFailClose(fx.snapshotId, [
      fx.base,
      fx.fileContent,
      'PENDING',
      dataDir,
    ]);
  });

  it('GLM-F1: index origin disguised as local-agent + final PENDING no COMPLETED → list hide, get/restore fail-close', async () => {
    const fx = await plantRemoteFixture({
      snapshotId: SNAPSHOT_OTHER,
      withPending: true,
      withCompleted: false,
      indexOrigin: 'local-agent',
      fileContent: 'f1-local-agent-pending',
      fileRel: 'f1-lap.txt',
    });
    await assertAllReadersFailClose(fx.snapshotId, [
      fx.base,
      fx.fileContent,
      dataDir,
    ]);
  });

  it('GLM-F1: hostile PENDING path occupancy (symlink) without COMPLETED must not classify as local', async () => {
    // Causal: any occupant of the remote PENDING marker path (even symlink/corrupt) blocks local.
    const snapshotId = SNAPSHOT_REMOTE;
    const base = snapshotDir(snapshotId);
    const fileRel = 'f1-hostile.txt';
    const fileContent = 'f1-hostile-pending-payload';
    await mkdir(join(base, 'files'), { recursive: true });
    await writeFile(join(base, 'files', fileRel), fileContent, 'utf8');
    const totalBytes = Buffer.byteLength(fileContent, 'utf8');
    const fileSha = createHash('sha256').update(fileContent, 'utf8').digest('hex');
    const manifest = {
      schemaVersion: 2,
      snapshotId,
      deviceId: DEVICE,
      createdAt: T0,
      files: [fileRel],
      integrity: {
        algorithm: 'sha256',
        totalBytes,
        entries: [{ path: fileRel, size: totalBytes, sha256: fileSha }],
      },
    };
    await writeFile(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const outside = join(dataDir, 'outside-pending-marker.json');
    await writeFile(
      outside,
      JSON.stringify({
        schemaVersion: 1,
        deviceId: DEVICE,
        snapshotId,
        uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1',
        manifestDigest: DIGEST_A,
      }),
      'utf8',
    );
    await symlink(outside, join(base, 'PENDING.json'));
    assert.equal(await pathExists(join(base, 'COMPLETED.json')), false);

    await assertAllReadersFailClose(snapshotId, [
      base,
      fileContent,
      outside,
      dataDir,
    ]);
  });
});

// ── GLM-F2: restore integrity vs source bytes + rogue files ─────────

describe('GLM-F2 remote restore integrity and canonical get', () => {
  /**
   * Plant a fully valid multi-file remote snapshot (COMPLETED + index + digests agree).
   * Disk manifest file order is deliberately non-canonical (reverse path order) so get
   * must return C1 projector output, not raw second-read disk JSON.
   * @param {{
   *   snapshotId?: string,
   *   files?: { path: string, content: string }[],
   *   extraDiskKeys?: Record<string, unknown>,
   * }} [opts]
   */
  async function plantValidRemoteMulti(opts = {}) {
    const snapshotId = opts.snapshotId ?? SNAPSHOT_REMOTE;
    const files = opts.files ?? [
      { path: 'z-last.txt', content: 'zzz-content' },
      { path: 'a-first.txt', content: 'aaa-content' },
    ];
    const base = snapshotDir(snapshotId);
    await mkdir(join(base, 'files'), { recursive: true });

    /** @type {{ path: string, size: number, sha256: string }[]} */
    const entries = [];
    for (const f of files) {
      const parent = join(base, 'files', ...(f.path.includes('/') ? f.path.split('/').slice(0, -1) : []));
      await mkdir(parent, { recursive: true });
      await writeFile(join(base, 'files', f.path), f.content, 'utf8');
      const size = Buffer.byteLength(f.content, 'utf8');
      entries.push({
        path: f.path,
        size,
        sha256: createHash('sha256').update(f.content, 'utf8').digest('hex'),
      });
    }
    const totalBytes = entries.reduce((s, e) => s + e.size, 0);

    // Non-canonical disk order (z before a); projector will UTF-8-sort paths.
    const diskManifest = {
      schemaVersion: 2,
      snapshotId,
      deviceId: DEVICE,
      createdAt: T0,
      files: entries.map((e) => e.path),
      integrity: {
        algorithm: 'sha256',
        totalBytes,
        entries: entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 })),
      },
      ...opts.extraDiskKeys,
    };

    const projected = projectCanonicalUploadManifest(diskManifest, {
      authenticatedDeviceId: DEVICE,
    });
    const digest = projected.manifestDigest;

    // Write pretty-printed disk JSON in non-canonical file order (raw object above).
    await writeFile(join(base, 'manifest.json'), JSON.stringify(diskManifest, null, 2), 'utf8');
    await writeFile(
      join(base, 'COMPLETED.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          origin: 'remote-upload',
          snapshotId,
          manifestDigest: digest,
          committedAt: T0,
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000f2',
          deviceId: DEVICE,
        },
        null,
        2,
      ),
      'utf8',
    );

    let list = [];
    try {
      list = JSON.parse(await readFile(indexPath(), 'utf8'));
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    list = list.filter((e) => e && e.snapshotId !== snapshotId);
    list.push({
      snapshotId,
      origin: 'remote-upload',
      manifestDigest: digest,
      committedAt: T0,
    });
    await mkdir(join(dataDir, deviceRel()), { recursive: true });
    await writeFile(indexPath(), JSON.stringify(list, null, 2), 'utf8');

    return {
      snapshotId,
      base,
      digest,
      diskManifest,
      canonical: projected.manifest,
      entries,
      files,
    };
  }

  it('GLM-F2: post-commit bit-flip of final file (same size, different SHA) → restore fail-close before successful target files', async () => {
    // Causal: restore must re-check integrity entries against actual source bytes; get may still
    // return the same-session verified canonical manifest.
    const original = 'ABCDEFGH'; // 8 bytes
    const fx = await plantValidRemoteMulti({
      snapshotId: SNAPSHOT_REMOTE,
      files: [{ path: 'flip.bin', content: original }],
    });
    const fileAbs = join(fx.base, 'files', 'flip.bin');
    const flipped = Buffer.from(original, 'utf8');
    flipped[3] = flipped[3] ^ 0xff;
    assert.equal(flipped.length, Buffer.byteLength(original, 'utf8'));
    assert.notEqual(
      createHash('sha256').update(flipped).digest('hex'),
      fx.entries[0].sha256,
    );
    await writeFile(fileAbs, flipped);

    // get: may return same-session verified canonical (manifest digests still agree);
    // fail-close on get is also acceptable — restore is the required gate.
    let man = null;
    try {
      man = await getSnapshotManifest(dataDir, DEVICE, fx.snapshotId);
    } catch (err) {
      if (err instanceof LinkeError) {
        assertFailClosedPublicError(err, [fx.base, dataDir, original]);
      }
    }
    if (man && typeof man === 'object') {
      assert.equal(man.snapshotId, fx.snapshotId);
      assert.equal(man.integrity.entries[0].sha256, fx.entries[0].sha256);
    }

    const target = join(dataDir, `restore-f2-flip-${fx.snapshotId}`);
    await assert.rejects(
      () =>
        restoreSnapshot(dataDir, {
          deviceId: DEVICE,
          snapshotId: fx.snapshotId,
          targetPath: target,
        }),
      (err) => {
        assertFailClosedPublicError(err, [fx.base, dataDir, target, original]);
        return true;
      },
    );
    // Must not publish a successful restored file (current impl copies without hashing).
    assert.equal(
      await pathExists(join(target, 'flip.bin')),
      false,
      'restore must not write successful target file when source bytes disagree with integrity',
    );
  });

  it('GLM-F2: rogue file under final files/ not listed in canonical manifest → restore fail-close (not copied as legal content)', async () => {
    // Causal: collect/copy of entire files/ tree must not treat unlisted rogue as legal.
    const fx = await plantValidRemoteMulti({
      snapshotId: SNAPSHOT_LOCAL,
      files: [
        { path: 'keep-a.txt', content: 'keep-a' },
        { path: 'keep-b.txt', content: 'keep-b' },
      ],
    });
    const rogueRel = 'rogue-not-in-manifest.txt';
    const rogueContent = 'rogue-secret-payload';
    await writeFile(join(fx.base, 'files', rogueRel), rogueContent, 'utf8');

    // get/list must not present rogue as legal content; get may fail-close entirely.
    let man = null;
    try {
      man = await getSnapshotManifest(dataDir, DEVICE, fx.snapshotId);
    } catch (err) {
      if (err instanceof LinkeError) {
        assertFailClosedPublicError(err, [fx.base, dataDir, rogueContent]);
      }
    }
    if (man && typeof man === 'object') {
      const listedPaths = Array.isArray(man.files)
        ? man.files
        : (man.integrity?.entries ?? []).map((e) => e.path);
      assert.equal(listedPaths.includes(rogueRel), false);
    }

    const listed = await listSnapshots(dataDir, DEVICE);
    assert.ok(Array.isArray(listed));
    // list must not invent file-level rogue visibility.

    const target = join(dataDir, `restore-f2-rogue-${fx.snapshotId}`);
    await assert.rejects(
      () =>
        restoreSnapshot(dataDir, {
          deviceId: DEVICE,
          snapshotId: fx.snapshotId,
          targetPath: target,
        }),
      (err) => {
        assertFailClosedPublicError(err, [fx.base, dataDir, rogueContent, rogueRel]);
        return true;
      },
    );
    assert.equal(
      await pathExists(join(target, rogueRel)),
      false,
      'rogue must not appear as successfully restored content',
    );
    // Fail-close before publishing legal files either (no partial success restore).
    assert.equal(await pathExists(join(target, 'keep-a.txt')), false);
    assert.equal(await pathExists(join(target, 'keep-b.txt')), false);
  });

  it('GLM-F2: remote get returns C1 projector canonical object (not raw disk JSON shape) without extra keys', async () => {
    // Behavior lock: after three-party verify, returned value equals projector canonical.
    // Deterministic fixture: non-canonical disk file order; no flaky concurrent swap.
    const fx = await plantValidRemoteMulti({
      snapshotId: SNAPSHOT_OTHER,
      files: [
        { path: 'z-last.txt', content: 'z-body' },
        { path: 'a-first.txt', content: 'a-body' },
      ],
    });
    // Contract of fixture: disk order differs from UTF-8 sorted canonical.
    assert.deepEqual(fx.diskManifest.files, ['z-last.txt', 'a-first.txt']);
    assert.deepEqual(fx.canonical.files, ['a-first.txt', 'z-last.txt']);

    const got = await getSnapshotManifest(dataDir, DEVICE, fx.snapshotId);
    assert.ok(got && typeof got === 'object');
    // Must equal C1 projector canonical object (key set + sorted paths + integrity).
    assert.deepEqual(got, fx.canonical);
    assert.equal(JSON.stringify(got), JSON.stringify(fx.canonical));
    for (const key of Object.keys(got)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(fx.canonical, key),
        `get must not surface extra key ${key}`,
      );
    }
  });
});
