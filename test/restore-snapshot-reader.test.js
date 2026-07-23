/**
 * RED tests for restore snapshot reader adapter (G0c C2).
 * Authority: plan C2 (assertSnapshotReadable) + design §§7.2 / 8.5 / 9.2.
 *
 * Production module is intentionally absent at RED; expected first failure is
 * ERR_MODULE_NOT_FOUND. Fixtures are independent literals — digests are oracled
 * by the real projectCanonicalUploadManifest (G0b authority), not by re-coding
 * the reader algorithm under test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import {
  RESTORE_CHUNK_SIZE_BYTES,
  createRestoreSnapshotReader,
} from '../src/restore-snapshot-reader.js';

const DEVICE_ID = 'device-alpha-001';
const DEVICE_SLUG = 'device-alpha-001'; // local createBackup often writes slug; may equal deviceId
const LOCAL_SLUG = 'devicealpha001'; // distinct slug vs authenticated deviceId
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440010';
const OTHER_SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440099';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const CREATED_AT = '2026-07-23T12:00:00.000Z';
const CHUNK = 8_388_608;
const INTEGRITY_CODE = ERROR_CODES.RESTORE_INTEGRITY_FAILED;

/** UTF-8 byte sort expectation (independent of production reader). */
function sortedByUtf8Bytes(paths) {
  return [...paths].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
}

/** Design §8.5 chunk formula — independent oracle, not a copy of reader source. */
function expectedChunkCount(size) {
  return size === 0 ? 0 : Math.ceil(size / CHUNK);
}

/**
 * Build a remote-upload canonical-shaped raw object (files path strings + integrity).
 * Insertion order mirrors G0b projector canonical key order for honest fixtures.
 */
function remoteCanonicalRaw(overrides = {}) {
  const files = overrides.files ?? ['docs/readme.txt', 'a.txt', 'empty.bin'];
  const entries = overrides.entries ?? [
    { path: 'docs/readme.txt', size: 12, sha256: SHA_A },
    { path: 'a.txt', size: CHUNK + 1, sha256: SHA_B },
    { path: 'empty.bin', size: 0, sha256: ZERO_SHA },
  ];
  const totalBytes =
    overrides.totalBytes ??
    entries.reduce((sum, e) => sum + e.size, 0);
  return {
    schemaVersion: 2,
    snapshotId: overrides.snapshotId ?? SNAPSHOT_ID,
    deviceId: overrides.deviceId ?? DEVICE_ID,
    createdAt: overrides.createdAt ?? CREATED_AT,
    files,
    integrity: {
      algorithm: overrides.algorithm ?? 'sha256',
      totalBytes,
      entries,
    },
    ...('hostname' in overrides ? { hostname: overrides.hostname } : {}),
    ...('sourcePath' in overrides ? { sourcePath: overrides.sourcePath } : {}),
  };
}

/**
 * Local/legacy schemaVersion 2 raw (createBackup shape): slug deviceId + optional ipAddress.
 */
function localLegacyRaw(overrides = {}) {
  const files = overrides.files ?? ['nested/file.dat', 'root.txt'];
  const entries = overrides.entries ?? [
    { path: 'nested/file.dat', size: 100, sha256: SHA_A },
    { path: 'root.txt', size: 0, sha256: ZERO_SHA },
  ];
  const totalBytes =
    overrides.totalBytes ??
    entries.reduce((sum, e) => sum + e.size, 0);
  const raw = {
    schemaVersion: 2,
    snapshotId: overrides.snapshotId ?? SNAPSHOT_ID,
    deviceId: overrides.deviceId ?? LOCAL_SLUG,
    createdAt: overrides.createdAt ?? CREATED_AT,
    hostname: overrides.hostname ?? 'mac-local.example',
    ipAddress: overrides.ipAddress ?? '192.0.2.10',
    sourcePath: overrides.sourcePath ?? '/Users/shared/backup-source',
    files,
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries,
    },
  };
  if (overrides.omitIpAddress) delete raw.ipAddress;
  if (overrides.omitHostname) delete raw.hostname;
  if (overrides.omitSourcePath) delete raw.sourcePath;
  return raw;
}

/**
 * Expected clean projector input per plan C2 step 4 (literal, not reader source).
 */
function expectedCleanFromRaw(raw, deviceId, snapshotId) {
  /** @type {Record<string, unknown>} */
  const clean = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: raw.createdAt,
    files: raw.files,
    integrity: {
      algorithm: 'sha256',
      totalBytes: raw.integrity.totalBytes,
      entries: raw.integrity.entries,
    },
  };
  if (typeof raw.hostname === 'string') clean.hostname = raw.hostname;
  if (typeof raw.sourcePath === 'string') clean.sourcePath = raw.sourcePath;
  return clean;
}

function expectedDigestForClean(clean, deviceId) {
  const { manifestDigest } = projectCanonicalUploadManifest(clean, {
    authenticatedDeviceId: deviceId,
  });
  return manifestDigest;
}

function expectedFilesFromClean(clean, deviceId) {
  const { manifest } = projectCanonicalUploadManifest(clean, {
    authenticatedDeviceId: deviceId,
  });
  return manifest.integrity.entries.map((entry, i) => ({
    fileIndex: i,
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
    chunkCount: expectedChunkCount(entry.size),
  }));
}

const RESULT_KEYS = Object.freeze(['manifestDigest', 'fileCount', 'totalBytes', 'files']);
const FILE_ENTRY_KEYS = Object.freeze([
  'fileIndex',
  'path',
  'size',
  'sha256',
  'chunkCount',
]);

/**
 * @param {unknown} error
 * @param {{ leakTokens?: unknown[] }} [opts]
 */
function assertIntegrityFailed(error, { leakTokens = [] } = {}) {
  assert.ok(error instanceof LinkeError, 'must be LinkeError');
  assert.strictEqual(error.code, INTEGRITY_CODE);
  assert.strictEqual(error.message, INTEGRITY_CODE);
  assert.strictEqual(error.code, 'restore-integrity-failed');
  assert.strictEqual(error.message, 'restore-integrity-failed');
  assert.strictEqual(error.statusCode, 422);
  assert.strictEqual(error.retryable, false);
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    // own enumerable fields only — never require stack inspection for pass
    ...Object.keys(error).map((k) => String(/** @type {Record<string, unknown>} */ (error)[k])),
  ].join('\0');
  for (const token of leakTokens) {
    if (token === '' || token == null) continue;
    assert.ok(
      !publicParts.includes(String(token)),
      `public LinkeError fields must not echo hostile token`,
    );
  }
  // Hard denylist for common leak surfaces
  assert.ok(!publicParts.includes('/Users/'));
  assert.ok(!publicParts.includes('secret-token'));
  assert.ok(!publicParts.includes('UPLOAD_INTEGRITY_FAILED'));
  assert.ok(!publicParts.includes('upload-integrity-failed'));
  assert.ok(!publicParts.includes('PROXY_SENTINEL'));
  assert.ok(!publicParts.includes('GETTER_SENTINEL'));
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {{ leakTokens?: unknown[] }} [opts]
 */
async function expectIntegrityFailed(fn, opts = {}) {
  await assert.rejects(fn, (error) => {
    assertIntegrityFailed(error, opts);
    return true;
  });
}

/**
 * @param {object} result
 */
function assertExactResultShape(result) {
  assert.strictEqual(typeof result, 'object');
  assert.ok(result !== null && !Array.isArray(result));
  assert.deepStrictEqual(Object.keys(result).sort(), [...RESULT_KEYS].sort());
  assert.match(result.manifestDigest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(result.fileCount));
  assert.ok(Number.isSafeInteger(result.totalBytes));
  assert.ok(Array.isArray(result.files));
  for (let i = 0; i < result.files.length; i += 1) {
    const f = result.files[i];
    assert.deepStrictEqual(Object.keys(f).sort(), [...FILE_ENTRY_KEYS].sort());
    assert.strictEqual(f.fileIndex, i);
    assert.strictEqual(typeof f.path, 'string');
    assert.ok(Number.isSafeInteger(f.size));
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(f.chunkCount));
  }
}

/**
 * @param {object} result
 */
function assertDeepFrozen(result) {
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.files));
  for (const f of result.files) {
    assert.ok(Object.isFrozen(f));
  }
  const before = JSON.stringify(result);
  assert.throws(() => {
    result.fileCount = 999;
  }, TypeError);
  assert.throws(() => {
    result.files.push({
      fileIndex: 99,
      path: 'x',
      size: 0,
      sha256: ZERO_SHA,
      chunkCount: 0,
    });
  }, TypeError);
  if (result.files.length > 0) {
    assert.throws(() => {
      result.files[0].path = 'mutated';
    }, TypeError);
  }
  assert.strictEqual(JSON.stringify(result), before);
}

/**
 * @param {object} result
 */
function assertNoSensitiveFields(result) {
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes('ipAddress'));
  assert.ok(!blob.includes('restoreRoot'));
  assert.ok(!blob.includes('/Users/'));
  assert.ok(!blob.includes('/var/'));
  assert.ok(!blob.includes('C:\\'));
  // Nested keys must not expose absolute endpoint paths
  for (const f of result.files) {
    assert.ok(!f.path.startsWith('/'));
    assert.ok(!Object.prototype.hasOwnProperty.call(f, 'absolutePath'));
    assert.ok(!Object.prototype.hasOwnProperty.call(f, 'restoreRoot'));
    assert.ok(!Object.prototype.hasOwnProperty.call(f, 'ipAddress'));
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'ipAddress'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'restoreRoot'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'absolutePath'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'dataDir'));
}

function createReader(mocks) {
  return createRestoreSnapshotReader({
    dataDir: '/tmp/linke-restore-reader-fixture-data-dir',
    getSnapshotManifestFn: mocks.getSnapshotManifestFn,
    projectCanonicalUploadManifestFn:
      mocks.projectCanonicalUploadManifestFn ?? projectCanonicalUploadManifest,
  });
}

// ── Constant + factory surface ─────────────────────────────────────

describe('RESTORE_CHUNK_SIZE_BYTES + factory surface', () => {
  it('exports RESTORE_CHUNK_SIZE_BYTES === 8_388_608', () => {
    assert.strictEqual(RESTORE_CHUNK_SIZE_BYTES, 8_388_608);
    assert.strictEqual(RESTORE_CHUNK_SIZE_BYTES, CHUNK);
  });

  it('factory returns frozen exact surface { assertSnapshotReadable }', () => {
    const reader = createReader({
      getSnapshotManifestFn: async () => remoteCanonicalRaw(),
    });
    assert.ok(Object.isFrozen(reader));
    assert.deepStrictEqual(Object.keys(reader).sort(), ['assertSnapshotReadable']);
    assert.strictEqual(typeof reader.assertSnapshotReadable, 'function');
    assert.throws(() => {
      /** @type {Record<string, unknown>} */ (reader).extra = 1;
    }, TypeError);
  });
});

// ── 1. remote-upload real canonical shape ──────────────────────────

describe('assertSnapshotReadable — remote-upload canonical shape', () => {
  it('digest matches real projectCanonicalUploadManifest; dense fileIndex; UTF-8 order; chunkCount formula', async () => {
    // Unsorted input order — reader/projector must emit UTF-8 path order.
    const raw = remoteCanonicalRaw({
      files: ['z.txt', 'a.txt', 'm/n.bin', 'empty.bin'],
      entries: [
        { path: 'z.txt', size: 1, sha256: SHA_A },
        { path: 'a.txt', size: CHUNK, sha256: SHA_B },
        { path: 'm/n.bin', size: CHUNK * 2 + 3, sha256: SHA_C },
        { path: 'empty.bin', size: 0, sha256: ZERO_SHA },
      ],
      totalBytes: 1 + CHUNK + (CHUNK * 2 + 3) + 0,
      hostname: 'uploader.example',
      sourcePath: 'opaque-source-label',
    });

    const clean = expectedCleanFromRaw(raw, DEVICE_ID, SNAPSHOT_ID);
    const expectedDigest = expectedDigestForClean(clean, DEVICE_ID);
    const expectedFiles = expectedFilesFromClean(clean, DEVICE_ID);
    const expectedOrder = sortedByUtf8Bytes(raw.files);

    let getCalls = 0;
    const reader = createReader({
      getSnapshotManifestFn: async (dataDir, deviceId, snapshotId) => {
        getCalls += 1;
        assert.strictEqual(deviceId, DEVICE_ID);
        assert.strictEqual(snapshotId, SNAPSHOT_ID);
        assert.strictEqual(typeof dataDir, 'string');
        return structuredClone(raw);
      },
    });

    const result = await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);

    assert.strictEqual(getCalls, 1);
    assertExactResultShape(result);
    assert.strictEqual(result.manifestDigest, expectedDigest);
    // Independent digest check: sha256(JSON.stringify(canonical))
    const { manifest } = projectCanonicalUploadManifest(clean, {
      authenticatedDeviceId: DEVICE_ID,
    });
    const wireDigest = createHash('sha256')
      .update(JSON.stringify(manifest), 'utf8')
      .digest('hex');
    assert.strictEqual(result.manifestDigest, wireDigest);

    assert.strictEqual(result.fileCount, expectedFiles.length);
    assert.strictEqual(result.totalBytes, raw.integrity.totalBytes);
    assert.strictEqual(result.files.length, expectedOrder.length);

    for (let i = 0; i < expectedOrder.length; i += 1) {
      assert.strictEqual(result.files[i].fileIndex, i);
      assert.strictEqual(result.files[i].path, expectedOrder[i]);
    }
    assert.deepStrictEqual(
      result.files.map((f) => f.path),
      expectedOrder,
    );

    // chunkCount independent oracle
    for (const f of result.files) {
      assert.strictEqual(f.chunkCount, expectedChunkCount(f.size));
    }
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    assert.strictEqual(byPath['empty.bin'].size, 0);
    assert.strictEqual(byPath['empty.bin'].chunkCount, 0);
    assert.strictEqual(byPath['a.txt'].size, CHUNK);
    assert.strictEqual(byPath['a.txt'].chunkCount, 1);
    assert.strictEqual(byPath['z.txt'].chunkCount, 1);
    assert.strictEqual(byPath['m/n.bin'].size, CHUNK * 2 + 3);
    assert.strictEqual(byPath['m/n.bin'].chunkCount, 3);

    assert.deepStrictEqual(result.files, expectedFiles);
    assertDeepFrozen(result);
    assertNoSensitiveFields(result);
  });
});

// ── 2. local/legacy schemaVersion 2 ────────────────────────────────

describe('assertSnapshotReadable — local/legacy schemaVersion 2', () => {
  it('uses call-param deviceId, strips ipAddress, deterministic, deep-frozen, no sensitive paths', async () => {
    const raw = localLegacyRaw({
      deviceId: LOCAL_SLUG,
      ipAddress: '203.0.113.50',
      hostname: 'endpoint-host.local',
      sourcePath: '/Users/shared/backup-source',
    });
    assert.notStrictEqual(raw.deviceId, DEVICE_ID, 'fixture must use slug ≠ call deviceId');

    const clean = expectedCleanFromRaw(raw, DEVICE_ID, SNAPSHOT_ID);
    assert.strictEqual(clean.deviceId, DEVICE_ID);
    assert.ok(!Object.prototype.hasOwnProperty.call(clean, 'ipAddress'));
    const expectedDigest = expectedDigestForClean(clean, DEVICE_ID);

    /** @type {unknown[]} */
    const projectorArgs = [];
    let getCalls = 0;
    const reader = createReader({
      getSnapshotManifestFn: async () => {
        getCalls += 1;
        return structuredClone(raw);
      },
      projectCanonicalUploadManifestFn: (input, options) => {
        projectorArgs.push({
          input: structuredClone(input),
          options: structuredClone(options),
        });
        return projectCanonicalUploadManifest(input, options);
      },
    });

    const first = await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);
    const second = await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);

    assert.strictEqual(getCalls, 2);
    assert.strictEqual(projectorArgs.length, 2);

    // Clean object exact: param deviceId, no ipAddress; hostname/sourcePath only as strings from raw
    for (const call of projectorArgs) {
      assert.deepStrictEqual(call.input, clean);
      assert.deepStrictEqual(call.options, { authenticatedDeviceId: DEVICE_ID });
      assert.strictEqual(call.input.deviceId, DEVICE_ID);
      assert.notStrictEqual(call.input.deviceId, LOCAL_SLUG);
      assert.ok(!Object.prototype.hasOwnProperty.call(call.input, 'ipAddress'));
    }

    assert.strictEqual(first.manifestDigest, expectedDigest);
    assert.strictEqual(second.manifestDigest, expectedDigest);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));

    assertExactResultShape(first);
    assertDeepFrozen(first);
    assertDeepFrozen(second);
    assertNoSensitiveFields(first);
    assertNoSensitiveFields(second);

    // Must not expose slug as device identity in files metadata blob
    const blob = JSON.stringify(first);
    assert.ok(!blob.includes('203.0.113.50'));
    assert.ok(!blob.includes('ipAddress'));
    assert.ok(!blob.includes('/Users/shared/backup-source')); // absolute only if leaked as field; path is optional sourcePath not in result
  });

  it('omits hostname/sourcePath on clean when raw lacks string values; still deterministic', async () => {
    const raw = localLegacyRaw({
      omitHostname: true,
      omitSourcePath: true,
      omitIpAddress: false,
      ipAddress: '198.51.100.7',
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(raw, 'hostname'));
    assert.ok(!Object.prototype.hasOwnProperty.call(raw, 'sourcePath'));

    /** @type {unknown[]} */
    const seenInputs = [];
    const reader = createReader({
      getSnapshotManifestFn: async () => structuredClone(raw),
      projectCanonicalUploadManifestFn: (input, options) => {
        seenInputs.push(structuredClone(input));
        return projectCanonicalUploadManifest(input, options);
      },
    });

    const a = await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);
    const b = await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);

    assert.strictEqual(seenInputs.length, 2);
    for (const input of seenInputs) {
      assert.ok(!Object.prototype.hasOwnProperty.call(input, 'hostname'));
      assert.ok(!Object.prototype.hasOwnProperty.call(input, 'sourcePath'));
      assert.ok(!Object.prototype.hasOwnProperty.call(input, 'ipAddress'));
      assert.strictEqual(input.deviceId, DEVICE_ID);
    }
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.manifestDigest, b.manifestDigest);
    assertDeepFrozen(a);
    assertNoSensitiveFields(a);
  });

  it('does not copy non-string hostname/sourcePath into projector clean input', async () => {
    const raw = localLegacyRaw({ omitIpAddress: true });
    // Hostile non-string optional fields must not enter clean
    raw.hostname = 12345;
    raw.sourcePath = { path: '/Users/evil' };

    /** @type {unknown[]} */
    const seenInputs = [];
    const reader = createReader({
      getSnapshotManifestFn: async () => structuredClone(raw),
      projectCanonicalUploadManifestFn: (input, options) => {
        seenInputs.push(structuredClone(input));
        return projectCanonicalUploadManifest(input, options);
      },
    });

    await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);
    assert.strictEqual(seenInputs.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(seenInputs[0], 'hostname'));
    assert.ok(!Object.prototype.hasOwnProperty.call(seenInputs[0], 'sourcePath'));
    assert.ok(!Object.prototype.hasOwnProperty.call(seenInputs[0], 'ipAddress'));
  });
});

// ── 5. projector invocation contract (success path) ────────────────

describe('assertSnapshotReadable — projector call contract', () => {
  it('calls projectCanonicalUploadManifestFn once with exact clean object and authenticatedDeviceId', async () => {
    const raw = remoteCanonicalRaw({
      hostname: 'h.example',
      sourcePath: 'src-label',
    });
    const clean = expectedCleanFromRaw(raw, DEVICE_ID, SNAPSHOT_ID);

    let projectorCalls = 0;
    /** @type {unknown} */
    let seenInput;
    /** @type {unknown} */
    let seenOptions;

    const reader = createReader({
      getSnapshotManifestFn: async () => structuredClone(raw),
      projectCanonicalUploadManifestFn: (input, options) => {
        projectorCalls += 1;
        seenInput = structuredClone(input);
        seenOptions = structuredClone(options);
        return projectCanonicalUploadManifest(input, options);
      },
    });

    await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);

    assert.strictEqual(projectorCalls, 1);
    assert.deepStrictEqual(seenInput, clean);
    assert.deepStrictEqual(seenOptions, { authenticatedDeviceId: DEVICE_ID });
    assert.strictEqual(
      /** @type {{ authenticatedDeviceId: string }} */ (seenOptions).authenticatedDeviceId,
      DEVICE_ID,
    );
  });
});

// ── 3. parameter / shape corruption ────────────────────────────────

describe('assertSnapshotReadable — shape corruption → restore-integrity-failed', () => {
  const cases = [
    {
      name: 'null return',
      raw: null,
      leak: [],
    },
    {
      name: 'undefined return',
      raw: undefined,
      leak: [],
    },
    {
      name: 'non-plain array',
      raw: [{ schemaVersion: 2 }],
      leak: [],
    },
    {
      name: 'non-plain Date',
      raw: new Date(CREATED_AT),
      leak: [],
    },
    {
      name: 'string return',
      raw: 'not-a-manifest',
      leak: ['not-a-manifest'],
    },
    {
      name: 'snapshotId mismatch',
      raw: remoteCanonicalRaw({ snapshotId: OTHER_SNAPSHOT_ID }),
      leak: [OTHER_SNAPSHOT_ID],
    },
    {
      name: 'files not an array',
      raw: (() => {
        const r = remoteCanonicalRaw();
        r.files = { 0: 'a.txt' };
        return r;
      })(),
      leak: [],
    },
    {
      name: 'files sparse hole',
      raw: (() => {
        const r = remoteCanonicalRaw();
        const files = ['a.txt'];
        files[2] = 'b.txt';
        r.files = files;
        r.integrity.entries = [
          { path: 'a.txt', size: 0, sha256: ZERO_SHA },
          { path: 'b.txt', size: 0, sha256: ZERO_SHA },
        ];
        r.integrity.totalBytes = 0;
        return r;
      })(),
      leak: [],
    },
    {
      name: 'files non-string element',
      raw: (() => {
        const r = remoteCanonicalRaw({
          files: ['a.txt'],
          entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          totalBytes: 0,
        });
        r.files = [42];
        return r;
      })(),
      leak: [],
    },
    {
      name: 'integrity missing',
      raw: (() => {
        const r = remoteCanonicalRaw();
        delete r.integrity;
        return r;
      })(),
      leak: [],
    },
    {
      name: 'integrity null',
      raw: (() => {
        const r = remoteCanonicalRaw();
        r.integrity = null;
        return r;
      })(),
      leak: [],
    },
    {
      name: 'integrity non-plain array',
      raw: (() => {
        const r = remoteCanonicalRaw();
        r.integrity = ['sha256'];
        return r;
      })(),
      leak: [],
    },
    {
      name: 'algorithm not sha256',
      raw: remoteCanonicalRaw({ algorithm: 'sha1' }),
      leak: ['sha1'],
    },
    {
      name: 'entries not dense (hole)',
      raw: (() => {
        const r = remoteCanonicalRaw({
          files: ['a.txt', 'b.txt'],
          entries: [
            { path: 'a.txt', size: 0, sha256: ZERO_SHA },
            { path: 'b.txt', size: 0, sha256: ZERO_SHA },
          ],
          totalBytes: 0,
        });
        const entries = [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }];
        entries[2] = { path: 'b.txt', size: 0, sha256: ZERO_SHA };
        r.integrity.entries = entries;
        return r;
      })(),
      leak: [],
    },
    {
      name: 'entry missing sha256 key',
      raw: (() => {
        const r = remoteCanonicalRaw({
          files: ['a.txt'],
          entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          totalBytes: 0,
        });
        r.integrity.entries = [{ path: 'a.txt', size: 0 }];
        return r;
      })(),
      leak: [],
    },
    {
      name: 'entry extra key',
      raw: (() => {
        const r = remoteCanonicalRaw({
          files: ['a.txt'],
          entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          totalBytes: 0,
        });
        r.integrity.entries = [
          { path: 'a.txt', size: 0, sha256: ZERO_SHA, extra: true },
        ];
        return r;
      })(),
      leak: [],
    },
    {
      name: 'bad size negative',
      raw: remoteCanonicalRaw({
        files: ['a.txt'],
        entries: [{ path: 'a.txt', size: -1, sha256: ZERO_SHA }],
        totalBytes: -1,
      }),
      leak: [],
    },
    {
      name: 'bad size float',
      raw: remoteCanonicalRaw({
        files: ['a.txt'],
        entries: [{ path: 'a.txt', size: 1.5, sha256: ZERO_SHA }],
        totalBytes: 1.5,
      }),
      leak: [],
    },
    {
      name: 'bad sha256 uppercase',
      raw: remoteCanonicalRaw({
        files: ['a.txt'],
        entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA.toUpperCase() }],
        totalBytes: 0,
      }),
      leak: [ZERO_SHA.toUpperCase().slice(0, 16)],
    },
    {
      name: 'bad sha256 short',
      raw: remoteCanonicalRaw({
        files: ['a.txt'],
        entries: [{ path: 'a.txt', size: 0, sha256: 'abc' }],
        totalBytes: 0,
      }),
      leak: ['abc'],
    },
    {
      name: 'unsafe absolute path',
      raw: remoteCanonicalRaw({
        files: ['/etc/passwd'],
        entries: [{ path: '/etc/passwd', size: 0, sha256: ZERO_SHA }],
        totalBytes: 0,
      }),
      leak: ['/etc/passwd'],
    },
    {
      name: 'unsafe path traversal',
      raw: remoteCanonicalRaw({
        files: ['../escape.txt'],
        entries: [{ path: '../escape.txt', size: 0, sha256: ZERO_SHA }],
        totalBytes: 0,
      }),
      leak: ['../escape.txt'],
    },
    {
      name: 'totalBytes not safe int (NaN)',
      raw: (() => {
        const r = remoteCanonicalRaw({
          files: ['a.txt'],
          entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          totalBytes: 0,
        });
        r.integrity.totalBytes = Number.NaN;
        return r;
      })(),
      leak: [],
    },
    {
      name: 'totalBytes not safe int (float)',
      raw: (() => {
        const r = remoteCanonicalRaw({
          files: ['a.txt'],
          entries: [{ path: 'a.txt', size: 1, sha256: SHA_A }],
          totalBytes: 1,
        });
        r.integrity.totalBytes = 1.25;
        return r;
      })(),
      leak: [],
    },
    {
      name: 'totalBytes mismatch with size sum',
      raw: remoteCanonicalRaw({
        files: ['a.txt', 'b.txt'],
        entries: [
          { path: 'a.txt', size: 10, sha256: SHA_A },
          { path: 'b.txt', size: 20, sha256: SHA_B },
        ],
        totalBytes: 999,
      }),
      leak: [],
    },
  ];

  for (const tc of cases) {
    it(`maps ${tc.name} to restore-integrity-failed without leaks`, async () => {
      const reader = createReader({
        getSnapshotManifestFn: async () => tc.raw,
      });
      await expectIntegrityFailed(
        () => reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
        { leakTokens: tc.leak },
      );
    });
  }

  it('maps projector throw to restore-integrity-failed without leaking projector message/path', async () => {
    const raw = remoteCanonicalRaw();
    const hostileMessage = 'projector boom /Users/ah/secret-token path=/var/evil stack';
    const reader = createReader({
      getSnapshotManifestFn: async () => structuredClone(raw),
      projectCanonicalUploadManifestFn: () => {
        throw new Error(hostileMessage);
      },
    });
    await expectIntegrityFailed(
      () => reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
      { leakTokens: [hostileMessage, '/Users/ah', 'secret-token', '/var/evil'] },
    );
  });

  it('maps projector LinkeError(UPLOAD_MANIFEST_INVALID) to restore-integrity-failed only', async () => {
    const raw = remoteCanonicalRaw();
    const reader = createReader({
      getSnapshotManifestFn: async () => structuredClone(raw),
      projectCanonicalUploadManifestFn: () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID, {
          statusCode: 400,
          retryable: false,
        });
      },
    });
    await expectIntegrityFailed(
      () => reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
      { leakTokens: ['upload-manifest-invalid', 'UPLOAD_MANIFEST_INVALID'] },
    );
  });
});

// ── 4. getSnapshotManifestFn throws ────────────────────────────────

describe('assertSnapshotReadable — getSnapshotManifestFn throws', () => {
  it('maps UPLOAD_INTEGRITY_FAILED to restore-integrity-failed without leak', async () => {
    const reader = createReader({
      getSnapshotManifestFn: async () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
        });
      },
    });
    await expectIntegrityFailed(
      () => reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
      {
        leakTokens: [
          'upload-integrity-failed',
          'UPLOAD_INTEGRITY_FAILED',
          ERROR_CODES.UPLOAD_INTEGRITY_FAILED,
        ],
      },
    );
  });

  it('maps arbitrary Error (with path/token/stack-ish message) uniquely to restore-integrity-failed', async () => {
    const leakPath = '/Users/ah/linke/data/repo/devices/x/snapshots/y/manifest.json';
    const leakToken = 'secret-token-abc123';
    const reader = createReader({
      getSnapshotManifestFn: async () => {
        const err = new Error(
          `ENOENT: no such file or directory, open '${leakPath}' token=${leakToken}`,
        );
        err.stack = `Error: open ${leakPath}\n    at Object.open (${leakPath}:1:1)\n    at secret-token-abc123`;
        throw err;
      },
    });
    await expectIntegrityFailed(
      () => reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
      { leakTokens: [leakPath, leakToken, 'ENOENT', 'manifest.json'] },
    );
  });

  it('maps TypeError and non-Error throw to restore-integrity-failed', async () => {
    const readerType = createReader({
      getSnapshotManifestFn: async () => {
        throw new TypeError('cannot read property of undefined at /Users/ah/x');
      },
    });
    await expectIntegrityFailed(
      () => readerType.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
      { leakTokens: ['/Users/ah/x', 'cannot read property'] },
    );

    const readerString = createReader({
      getSnapshotManifestFn: async () => {
        throw 'raw-string-failure-secret-token';
      },
    });
    await expectIntegrityFailed(
      () => readerString.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID),
      { leakTokens: ['raw-string-failure-secret-token', 'secret-token'] },
    );
  });
});

// ── Result field exactness ─────────────────────────────────────────

describe('assertSnapshotReadable — result exact keys only', () => {
  it('result and nested files have exact keys and no extras', async () => {
    const raw = remoteCanonicalRaw({
      files: ['only.txt'],
      entries: [{ path: 'only.txt', size: 7, sha256: SHA_A }],
      totalBytes: 7,
    });
    const reader = createReader({
      getSnapshotManifestFn: async () => structuredClone(raw),
    });
    const result = await reader.assertSnapshotReadable(DEVICE_ID, SNAPSHOT_ID);
    assertExactResultShape(result);
    assert.strictEqual(result.fileCount, 1);
    assert.strictEqual(result.totalBytes, 7);
    assert.strictEqual(result.files[0].chunkCount, 1);
    assertDeepFrozen(result);
    assertNoSensitiveFields(result);
  });
});
