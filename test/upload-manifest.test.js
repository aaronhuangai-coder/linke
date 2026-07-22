import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  projectCanonicalUploadManifest,
  assertSafeManifestPath,
  UPLOAD_MANIFEST_LIMITS,
} from '../src/upload-manifest.js';

const DEVICE_ID = 'device-alpha-001';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440000';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FILE_SHA = 'a'.repeat(64);

function baseInput(overrides = {}) {
  return {
    schemaVersion: 2,
    snapshotId: SNAPSHOT_ID,
    deviceId: DEVICE_ID,
    createdAt: '2026-07-22T12:00:00.000Z',
    files: ['a.txt'],
    integrity: {
      algorithm: 'sha256',
      totalBytes: 0,
      entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
    },
    ...overrides,
  };
}

function expectManifestInvalid(fn, { leakTokens = [] } = {}) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof LinkeError);
      assert.strictEqual(error.code, ERROR_CODES.UPLOAD_MANIFEST_INVALID);
      assert.strictEqual(error.message, ERROR_CODES.UPLOAD_MANIFEST_INVALID);
      assert.strictEqual(error.statusCode, 400);
      assert.strictEqual(error.retryable, false);
      // Public own fields only (not Node stack — stacks include local file paths).
      const publicParts = [
        error.code,
        error.message,
        error.name,
        String(error.statusCode),
        String(error.retryable),
      ].join('\0');
      for (const token of leakTokens) {
        assert.ok(!publicParts.includes(token), `public fields must not echo ${token}`);
      }
      return true;
    },
  );
}

function expectedDigest(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}

/** UTF-8 byte sort expectation — never rely on JS string code-unit order alone. */
function sortedByUtf8Bytes(paths) {
  return [...paths].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
}

/**
 * Sparse Array Proxy with hostile length=MAX_FILE_COUNT+1.
 * Records ownKeys calls; must be rejected before ownKeys (no huge loops).
 */
function makeOversizeLengthArrayProxy() {
  const oversize = UPLOAD_MANIFEST_LIMITS.MAX_FILE_COUNT + 1;
  const target = [];
  target.length = oversize;
  let ownKeysCalls = 0;
  const proxy = new Proxy(target, {
    ownKeys(t) {
      ownKeysCalls += 1;
      return Reflect.ownKeys(t);
    },
  });
  return {
    proxy,
    oversize,
    get ownKeysCalls() {
      return ownKeysCalls;
    },
  };
}

describe('UPLOAD_MANIFEST_LIMITS', () => {
  it('exports frozen bounded constants', () => {
    assert.ok(Object.isFrozen(UPLOAD_MANIFEST_LIMITS));
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_FILE_COUNT, 100_000);
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_PATH_UTF8_BYTES, 1024);
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_FILE_SIZE_BYTES, 512 * 1024 ** 3);
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES, 8 * 1024 * 1024);
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_HOSTNAME_UTF8_BYTES, 255);
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_SOURCE_PATH_UTF8_BYTES, 4096);
  });
});

describe('assertSafeManifestPath', () => {
  it('accepts safe relative paths and returns the original string', () => {
    assert.strictEqual(assertSafeManifestPath('a.txt'), 'a.txt');
    assert.strictEqual(assertSafeManifestPath('dir/sub/file.bin'), 'dir/sub/file.bin');
  });

  it('rejects empty, absolute, backslash, NUL, controls, empty/dot/dotdot segments', () => {
    const bad = [
      '',
      '/',
      '/abs',
      'a\\b',
      'a\0b',
      'a\nb',
      'a\rb',
      'a\x7fb',
      'a//b',
      'a/./b',
      'a/../b',
      './a',
      '../a',
      'a/',
      '.',
      '..',
    ];
    for (const path of bad) {
      expectManifestInvalid(() => assertSafeManifestPath(path));
    }
  });

  it('accepts exact 1024 UTF-8 path bytes and rejects 1025', () => {
    // 'p' is 1 UTF-8 byte each
    const exact = 'p'.repeat(1024);
    assert.strictEqual(Buffer.byteLength(exact, 'utf8'), 1024);
    assert.strictEqual(assertSafeManifestPath(exact), exact);
    const over = 'p'.repeat(1025);
    assert.ok(Buffer.byteLength(over, 'utf8') > 1024);
    expectManifestInvalid(() => assertSafeManifestPath(over), { leakTokens: [over.slice(0, 32)] });
  });

  it('rejects paths exceeding 1024 UTF-8 bytes without echoing the path', () => {
    const path = `${'p'.repeat(1025)}.txt`;
    assert.ok(Buffer.byteLength(path, 'utf8') > 1024);
    expectManifestInvalid(() => assertSafeManifestPath(path), { leakTokens: [path.slice(0, 32)] });
  });

  it('rejects drive-like absolute paths', () => {
    for (const path of ['C:/x', 'c:', 'C:foo', 'z:bar/baz', 'D:\\win']) {
      expectManifestInvalid(() => assertSafeManifestPath(path), { leakTokens: [path] });
    }
  });

  it('rejects unpaired UTF-16 surrogates and accepts well-formed emoji paths', () => {
    const loneHigh = `dir/\uD800file.txt`;
    const loneLow = `dir/\uDCFFfile.txt`;
    expectManifestInvalid(() => assertSafeManifestPath(loneHigh));
    expectManifestInvalid(() => assertSafeManifestPath(loneLow));
    const emojiPath = 'assets/😀-icon.bin';
    assert.strictEqual(assertSafeManifestPath(emojiPath), emojiPath);
    assert.ok(Buffer.byteLength(emojiPath, 'utf8') <= 1024);
  });
});

describe('projectCanonicalUploadManifest', () => {
  it('projects a minimal valid manifest with stable digest and deep-frozen result', () => {
    const input = baseInput();
    const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
      authenticatedDeviceId: DEVICE_ID,
    });
    assert.strictEqual(manifest.schemaVersion, 2);
    assert.strictEqual(manifest.snapshotId, SNAPSHOT_ID);
    assert.strictEqual(manifest.deviceId, DEVICE_ID);
    assert.strictEqual(manifest.createdAt, '2026-07-22T12:00:00.000Z');
    assert.deepStrictEqual(manifest.files, ['a.txt']);
    assert.strictEqual(manifest.integrity.algorithm, 'sha256');
    assert.strictEqual(manifest.integrity.totalBytes, 0);
    assert.deepStrictEqual(manifest.integrity.entries, [
      { path: 'a.txt', size: 0, sha256: ZERO_SHA },
    ]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(manifest, 'hostname'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(manifest, 'sourcePath'), false);
    assert.strictEqual(manifestDigest, expectedDigest(manifest));
    assert.match(manifestDigest, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.files));
    assert.ok(Object.isFrozen(manifest.integrity));
    assert.ok(Object.isFrozen(manifest.integrity.entries));
    assert.ok(Object.isFrozen(manifest.integrity.entries[0]));
    // Deep freeze is real: strict-mode mutation throws; snapshot unchanged.
    const before = JSON.stringify(manifest);
    assert.throws(() => {
      manifest.schemaVersion = 99;
    }, TypeError);
    assert.throws(() => {
      manifest.files.push('x');
    }, TypeError);
    assert.throws(() => {
      manifest.integrity.totalBytes = 1;
    }, TypeError);
    assert.throws(() => {
      manifest.integrity.entries[0].path = 'mutated';
    }, TypeError);
    assert.strictEqual(JSON.stringify(manifest), before);
  });

  it('sorts files/entries by UTF-8 path bytes and is order-independent for digest', () => {
    const entryB = { path: 'b.txt', size: 1, sha256: FILE_SHA };
    const entryA = { path: 'a.txt', size: 2, sha256: FILE_SHA };
    const left = projectCanonicalUploadManifest(
      baseInput({
        files: ['b.txt', 'a.txt'],
        integrity: { algorithm: 'sha256', totalBytes: 3, entries: [entryB, entryA] },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    const right = projectCanonicalUploadManifest(
      baseInput({
        files: ['a.txt', 'b.txt'],
        integrity: { algorithm: 'sha256', totalBytes: 3, entries: [entryA, entryB] },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    const expectedOrder = sortedByUtf8Bytes(['a.txt', 'b.txt']);
    assert.deepStrictEqual(left.manifest.files, expectedOrder);
    assert.deepStrictEqual(
      left.manifest.integrity.entries.map((e) => e.path),
      expectedOrder,
    );
    assert.strictEqual(left.manifestDigest, right.manifestDigest);
    assert.deepStrictEqual(left.manifest, right.manifest);
  });

  it('accepts independent files vs entries permutations after separate UTF-8 sorts', () => {
    const entryA = { path: 'a.txt', size: 2, sha256: FILE_SHA };
    const entryB = { path: 'b.txt', size: 1, sha256: FILE_SHA };
    // files order b,a — entries order a,b (independent permutation; not index-aligned)
    const independent = projectCanonicalUploadManifest(
      baseInput({
        files: ['b.txt', 'a.txt'],
        integrity: { algorithm: 'sha256', totalBytes: 3, entries: [entryA, entryB] },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    const aligned = projectCanonicalUploadManifest(
      baseInput({
        files: ['a.txt', 'b.txt'],
        integrity: { algorithm: 'sha256', totalBytes: 3, entries: [entryA, entryB] },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    const filesOnlyPerm = projectCanonicalUploadManifest(
      baseInput({
        files: ['b.txt', 'a.txt'],
        integrity: { algorithm: 'sha256', totalBytes: 3, entries: [entryB, entryA] },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    const expectedOrder = sortedByUtf8Bytes(['a.txt', 'b.txt']);
    assert.deepStrictEqual(independent.manifest.files, expectedOrder);
    assert.deepStrictEqual(
      independent.manifest.integrity.entries.map((e) => e.path),
      expectedOrder,
    );
    assert.strictEqual(independent.manifestDigest, aligned.manifestDigest);
    assert.strictEqual(independent.manifestDigest, filesOnlyPerm.manifestDigest);
    assert.deepStrictEqual(independent.manifest, aligned.manifest);
  });

  it('uses fixed canonical key insertion order for digest stability', () => {
    const { manifest, manifestDigest } = projectCanonicalUploadManifest(
      baseInput({
        hostname: 'host.example',
        sourcePath: 'opaque-source',
        files: ['z.txt', 'a.txt'],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 0,
          entries: [
            { path: 'z.txt', size: 0, sha256: ZERO_SHA },
            { path: 'a.txt', size: 0, sha256: ZERO_SHA },
          ],
        },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.deepStrictEqual(Object.keys(manifest), [
      'schemaVersion',
      'snapshotId',
      'deviceId',
      'createdAt',
      'hostname',
      'files',
      'integrity',
      'sourcePath',
    ]);
    assert.deepStrictEqual(Object.keys(manifest.integrity), [
      'algorithm',
      'totalBytes',
      'entries',
    ]);
    assert.deepStrictEqual(Object.keys(manifest.integrity.entries[0]), [
      'path',
      'size',
      'sha256',
    ]);
    // Reordered input keys must not change digest
    const reordered = {
      sourcePath: 'opaque-source',
      integrity: {
        entries: [
          { sha256: ZERO_SHA, path: 'z.txt', size: 0 },
          { sha256: ZERO_SHA, path: 'a.txt', size: 0 },
        ],
        totalBytes: 0,
        algorithm: 'sha256',
      },
      files: ['z.txt', 'a.txt'],
      hostname: 'host.example',
      createdAt: '2026-07-22T12:00:00.000Z',
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      schemaVersion: 2,
    };
    const again = projectCanonicalUploadManifest(reordered, {
      authenticatedDeviceId: DEVICE_ID,
    });
    assert.strictEqual(again.manifestDigest, manifestDigest);
  });

  it('accepts Object.create(null) input and optional hostname/sourcePath', () => {
    const input = Object.assign(Object.create(null), baseInput({
      hostname: 'edge-host',
      sourcePath: '/opaque/never/resolved',
    }));
    const { manifest } = projectCanonicalUploadManifest(input, {
      authenticatedDeviceId: DEVICE_ID,
    });
    assert.strictEqual(manifest.hostname, 'edge-host');
    assert.strictEqual(manifest.sourcePath, '/opaque/never/resolved');
  });

  it('does not mutate the input object', () => {
    const input = baseInput({
      files: ['b.txt', 'a.txt'],
      integrity: {
        algorithm: 'sha256',
        totalBytes: 0,
        entries: [
          { path: 'b.txt', size: 0, sha256: ZERO_SHA },
          { path: 'a.txt', size: 0, sha256: ZERO_SHA },
        ],
      },
    });
    const before = JSON.stringify(input);
    projectCanonicalUploadManifest(input, { authenticatedDeviceId: DEVICE_ID });
    assert.strictEqual(JSON.stringify(input), before);
    assert.deepStrictEqual(input.files, ['b.txt', 'a.txt']);
  });

  it('normalizes snapshotId to lowercase and createdAt to canonical ISO UTC', () => {
    const { manifest } = projectCanonicalUploadManifest(
      baseInput({
        snapshotId: '550E8400-E29B-41D4-A716-446655440000',
        createdAt: '2026-07-22T12:00:00Z',
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.strictEqual(manifest.snapshotId, SNAPSHOT_ID);
    assert.strictEqual(manifest.createdAt, '2026-07-22T12:00:00.000Z');
  });

  it('accepts only strict ISO-UTC createdAt forms and rejects non-ISO / illegal calendar', () => {
    // Already-canonical with millis
    const withMs = projectCanonicalUploadManifest(
      baseInput({ createdAt: '2026-07-22T12:00:00.000Z' }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.strictEqual(withMs.manifest.createdAt, '2026-07-22T12:00:00.000Z');

    const nonIso = [
      'July 22, 2026',
      '2026-07-22 12:00:00Z', // space separator
      '2026-07-22T12:00:00+08:00', // offset
      '2026-07-22T12:00Z', // no seconds
      '2026-07-22T12:00:00.12Z', // millis not exactly 3
      '2026-07-22T12:00:00.1234Z',
      '2026-02-30T00:00:00.000Z', // illegal calendar (rolls / mismatches canonical)
      '2026-13-01T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
    ];
    for (const createdAt of nonIso) {
      expectManifestInvalid(
        () =>
          projectCanonicalUploadManifest(baseInput({ createdAt }), {
            authenticatedDeviceId: DEVICE_ID,
          }),
        { leakTokens: [String(createdAt).slice(0, 24)] },
      );
    }
  });

  it('rejects hostname unpaired surrogates without echo', () => {
    const loneHigh = `host\uD800name`;
    const loneLow = `host\uDCFFname`;
    expectManifestInvalid(
      () =>
        projectCanonicalUploadManifest(baseInput({ hostname: loneHigh }), {
          authenticatedDeviceId: DEVICE_ID,
        }),
      { leakTokens: ['host'] },
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ hostname: loneLow }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
  });

  it('rejects oversize ownKeys before getOwnPropertyDescriptor (maxKeys early stop)', () => {
    // top maxKeys=8: return 9 own keys via Proxy; descriptor must not run.
    const topKeys = [
      'schemaVersion',
      'snapshotId',
      'deviceId',
      'createdAt',
      'files',
      'integrity',
      'hostname',
      'sourcePath',
      'extra',
    ];
    let descriptorCalls = 0;
    const overKeyTop = new Proxy(
      {},
      {
        getPrototypeOf() {
          return Object.prototype;
        },
        ownKeys() {
          return topKeys;
        },
        getOwnPropertyDescriptor(_t, key) {
          descriptorCalls += 1;
          return {
            value: key === 'schemaVersion' ? 2 : null,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        },
      },
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(overKeyTop, { authenticatedDeviceId: DEVICE_ID }),
    );
    assert.strictEqual(
      descriptorCalls,
      0,
      'getOwnPropertyDescriptor must not run after ownKeys.length > maxKeys',
    );
  });

  it('canonical entry objects expose only path,size,sha256 (no sort-cache fields)', () => {
    const { manifest } = projectCanonicalUploadManifest(
      baseInput({
        files: ['b.txt', 'a.txt'],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 0,
          entries: [
            { path: 'b.txt', size: 0, sha256: ZERO_SHA },
            { path: 'a.txt', size: 0, sha256: ZERO_SHA },
          ],
        },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    for (const entry of manifest.integrity.entries) {
      assert.deepStrictEqual(Object.keys(entry), ['path', 'size', 'sha256']);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'utf8'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, '_utf8'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'bytes'), false);
    }
  });

  it('accepts matching claimedManifestDigest from options only', () => {
    const { manifestDigest } = projectCanonicalUploadManifest(baseInput(), {
      authenticatedDeviceId: DEVICE_ID,
    });
    const again = projectCanonicalUploadManifest(baseInput(), {
      authenticatedDeviceId: DEVICE_ID,
      claimedManifestDigest: manifestDigest,
    });
    assert.strictEqual(again.manifestDigest, manifestDigest);
    // claimed digest must never appear as a canonical key
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(again.manifest, 'claimedManifestDigest'),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(again.manifest, 'manifestDigest'),
      false,
    );
  });

  it('rejects mismatched or malformed claimedManifestDigest with upload-manifest-invalid only', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), {
        authenticatedDeviceId: DEVICE_ID,
        claimedManifestDigest: '0'.repeat(64),
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), {
        authenticatedDeviceId: DEVICE_ID,
        claimedManifestDigest: 'NOT-HEX',
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), {
        authenticatedDeviceId: DEVICE_ID,
        claimedManifestDigest: 'A'.repeat(64), // upper hex rejected
      }),
    );
    for (const bad of [123, null, true, false, { hex: ZERO_SHA }, ['a']]) {
      expectManifestInvalid(() =>
        projectCanonicalUploadManifest(baseInput(), {
          authenticatedDeviceId: DEVICE_ID,
          claimedManifestDigest: bad,
        }),
      );
    }
  });

  it('rejects omitted options (missing authenticatedDeviceId SoT)', () => {
    expectManifestInvalid(() => projectCanonicalUploadManifest(baseInput()));
  });

  it('rejects deviceId that does not exactly match authenticatedDeviceId', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ deviceId: 'other-device' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), {
        authenticatedDeviceId: '',
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), {
        authenticatedDeviceId: 123,
      }),
    );
  });

  it('rejects unknown top-level keys including ipAddress', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ ipAddress: '10.0.0.1' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ extra: true }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
  });

  it('rejects unknown integrity/entry keys', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
            extra: 1,
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA, mode: 0o644 }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects non-plain objects, arrays, null, Date, and class instances', () => {
    class ManifestClass {
      constructor() {
        Object.assign(this, baseInput());
      }
    }
    for (const bad of [null, undefined, [], baseInput(), new Date(), new ManifestClass()]) {
      if (bad && typeof bad === 'object' && !Array.isArray(bad) && !(bad instanceof Date) && !(bad instanceof ManifestClass)) {
        // plain baseInput is valid — skip
        continue;
      }
      if (bad && typeof bad === 'object' && Object.getPrototypeOf(bad) === Object.prototype) {
        continue;
      }
      expectManifestInvalid(() =>
        projectCanonicalUploadManifest(bad, { authenticatedDeviceId: DEVICE_ID }),
      );
    }
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(new Date(), { authenticatedDeviceId: DEVICE_ID }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(new ManifestClass(), { authenticatedDeviceId: DEVICE_ID }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(null, { authenticatedDeviceId: DEVICE_ID }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest([], { authenticatedDeviceId: DEVICE_ID }),
    );
  });

  it('rejects hostile getters/setters/symbols without invoking getters', () => {
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'schemaVersion', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 2;
      },
    });
    Object.defineProperty(hostile, 'snapshotId', {
      enumerable: true,
      value: SNAPSHOT_ID,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(hostile, 'deviceId', {
      enumerable: true,
      value: DEVICE_ID,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(hostile, 'createdAt', {
      enumerable: true,
      value: '2026-07-22T12:00:00.000Z',
      writable: true,
      configurable: true,
    });
    Object.defineProperty(hostile, 'files', {
      enumerable: true,
      value: ['a.txt'],
      writable: true,
      configurable: true,
    });
    Object.defineProperty(hostile, 'integrity', {
      enumerable: true,
      value: {
        algorithm: 'sha256',
        totalBytes: 0,
        entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
      },
      writable: true,
      configurable: true,
    });
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(hostile, { authenticatedDeviceId: DEVICE_ID }),
    );
    assert.strictEqual(getterCalls, 0, 'hostile getter must not be invoked');

    const withSymbol = baseInput();
    Object.defineProperty(withSymbol, Symbol('x'), {
      enumerable: true,
      value: 1,
    });
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(withSymbol, { authenticatedDeviceId: DEVICE_ID }),
    );
  });

  it('rejects sparse or accessor arrays for files/entries without invoking index getters', () => {
    let indexGets = 0;
    const sparseFiles = ['a.txt'];
    sparseFiles[2] = 'c.txt';
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: sparseFiles,
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [
              { path: 'a.txt', size: 0, sha256: ZERO_SHA },
              { path: 'c.txt', size: 0, sha256: ZERO_SHA },
            ],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );

    const accessorFiles = [];
    accessorFiles.length = 1;
    Object.defineProperty(accessorFiles, '0', {
      enumerable: true,
      configurable: true,
      get() {
        indexGets += 1;
        return 'a.txt';
      },
    });
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: accessorFiles,
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    assert.strictEqual(indexGets, 0, 'array index getter must not be invoked');
  });

  it('rejects invalid schemaVersion, algorithm, snapshotId, createdAt', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ schemaVersion: 1 }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha512',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ snapshotId: 'not-a-uuid' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    // UUID version 0 / bad variant
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({ snapshotId: '550e8400-e29b-01d4-a716-446655440000' }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({ snapshotId: '550e8400-e29b-41d4-c716-446655440000' }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ createdAt: 'not-a-date' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ createdAt: '2026-13-40T99:99:99.000Z' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ createdAt: 1721650000000 }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
  });

  it('rejects duplicate paths and files/entries mismatches', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: ['a.txt', 'a.txt'],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [
              { path: 'a.txt', size: 0, sha256: ZERO_SHA },
              { path: 'a.txt', size: 0, sha256: ZERO_SHA },
            ],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: ['a.txt', 'b.txt'],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: ['a.txt'],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [
              { path: 'a.txt', size: 0, sha256: ZERO_SHA },
              { path: 'b.txt', size: 0, sha256: ZERO_SHA },
            ],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: ['a.txt'],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'b.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects unsafe sizes, sha256, totalBytes mismatch, and oversize file count', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 1,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 1.5, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: -1, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: 'ABCDEF' }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [
              {
                path: 'a.txt',
                size: 512 * 1024 ** 3 + 1,
                sha256: ZERO_SHA,
              },
            ],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects unsafe hostname and sourcePath bounds/controls without echo', () => {
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ hostname: '' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(
      () =>
        projectCanonicalUploadManifest(baseInput({ hostname: 'secret-host\n' }), {
          authenticatedDeviceId: DEVICE_ID,
        }),
      { leakTokens: ['secret-host'] },
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ hostname: 'h'.repeat(256) }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    // empty sourcePath is invalid (optional = omit or non-empty opaque)
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ sourcePath: '' }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    // non-empty opaque absolute-looking still allowed (never resolve/open)
    const slashOnly = projectCanonicalUploadManifest(baseInput({ sourcePath: '/' }), {
      authenticatedDeviceId: DEVICE_ID,
    });
    assert.strictEqual(slashOnly.manifest.sourcePath, '/');
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ sourcePath: 'x'.repeat(4097) }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput({ sourcePath: 123 }), {
        authenticatedDeviceId: DEVICE_ID,
      }),
    );
  });

  it('rejects unsafe paths in files/entries without echoing path', () => {
    const secret = 'secret-dir/../escape.txt';
    expectManifestInvalid(
      () =>
        projectCanonicalUploadManifest(
          baseInput({
            files: [secret],
            integrity: {
              algorithm: 'sha256',
              totalBytes: 0,
              entries: [{ path: secret, size: 0, sha256: ZERO_SHA }],
            },
          }),
          { authenticatedDeviceId: DEVICE_ID },
        ),
      { leakTokens: [secret, 'secret-dir', 'escape.txt'] },
    );
  });

  it('allows zero-byte entries and multi-file non-zero sizes with exact totalBytes', () => {
    const { manifest } = projectCanonicalUploadManifest(
      baseInput({
        files: ['empty.bin', 'data.bin'],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 10,
          entries: [
            { path: 'empty.bin', size: 0, sha256: ZERO_SHA },
            { path: 'data.bin', size: 10, sha256: FILE_SHA },
          ],
        },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.strictEqual(manifest.integrity.totalBytes, 10);
    const expectedOrder = sortedByUtf8Bytes(['empty.bin', 'data.bin']);
    assert.deepStrictEqual(manifest.files, expectedOrder);
    assert.strictEqual(manifest.integrity.entries[0].path, expectedOrder[0]);
    assert.strictEqual(manifest.integrity.entries[1].path, expectedOrder[1]);
    const byPath = Object.fromEntries(
      manifest.integrity.entries.map((e) => [e.path, e.size]),
    );
    assert.strictEqual(byPath['empty.bin'], 0);
    assert.strictEqual(byPath['data.bin'], 10);
  });

  it('accepts empty files/entries with totalBytes 0 (canonical empty snapshot)', () => {
    const { manifest, manifestDigest } = projectCanonicalUploadManifest(
      baseInput({
        files: [],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 0,
          entries: [],
        },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.deepStrictEqual(manifest.files, []);
    assert.deepStrictEqual(manifest.integrity.entries, []);
    assert.strictEqual(manifest.integrity.totalBytes, 0);
    assert.strictEqual(manifest.integrity.algorithm, 'sha256');
    assert.strictEqual(manifestDigest, expectedDigest(manifest));
    assert.match(manifestDigest, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.files));
    assert.ok(Object.isFrozen(manifest.integrity));
    assert.ok(Object.isFrozen(manifest.integrity.entries));
    const before = JSON.stringify(manifest);
    assert.throws(() => {
      manifest.files.push('x');
    }, TypeError);
    assert.strictEqual(JSON.stringify(manifest), before);
  });

  it('rejects non-string files entries (e.g. number) with upload-manifest-invalid', () => {
    // Regression: dense array of numbers must not pass typeof path checks.
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: [123],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects files arrays with extra non-index own properties', () => {
    const files = ['a.txt'];
    files.customProp = 1;
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files,
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects oversize file-count Array Proxy before ownKeys (early bound DoS guard)', () => {
    assert.strictEqual(UPLOAD_MANIFEST_LIMITS.MAX_FILE_COUNT, 100_000);
    const filesProxy = makeOversizeLengthArrayProxy();
    assert.strictEqual(filesProxy.proxy.length, filesProxy.oversize);
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: filesProxy.proxy,
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    assert.strictEqual(
      filesProxy.ownKeysCalls,
      0,
      'ownKeys must not run when length > MAX_FILE_COUNT',
    );

    // Same guard on integrity.entries
    const entriesProxy = makeOversizeLengthArrayProxy();
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files: ['a.txt'],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: entriesProxy.proxy,
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    assert.strictEqual(entriesProxy.ownKeysCalls, 0);
  });

  it('accepts exact 512GiB file size and rejects non-safe totalBytes', () => {
    const maxSize = UPLOAD_MANIFEST_LIMITS.MAX_FILE_SIZE_BYTES;
    const ok = projectCanonicalUploadManifest(
      baseInput({
        integrity: {
          algorithm: 'sha256',
          totalBytes: maxSize,
          entries: [{ path: 'a.txt', size: maxSize, sha256: FILE_SHA }],
        },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.strictEqual(ok.manifest.integrity.entries[0].size, maxSize);
    assert.strictEqual(ok.manifest.integrity.totalBytes, maxSize);

    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: Number.MAX_SAFE_INTEGER + 1,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          integrity: {
            algorithm: 'sha256',
            totalBytes: 1.5,
            entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects entry size sums that overflow Number.MAX_SAFE_INTEGER', () => {
    const maxSize = UPLOAD_MANIFEST_LIMITS.MAX_FILE_SIZE_BYTES;
    // ceil((MAX_SAFE+1)/maxSize) — bounded (~16385), no 2^32 loops
    const count = Math.floor(Number.MAX_SAFE_INTEGER / maxSize) + 1;
    assert.ok(count > 1 && count < 20_000);
    /** @type {string[]} */
    const files = [];
    /** @type {{ path: string, size: number, sha256: string }[]} */
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      // short unique paths; pad keeps lexicographic uniqueness without huge strings
      const path = `f${String(i).padStart(5, '0')}`;
      files.push(path);
      entries.push({ path, size: maxSize, sha256: ZERO_SHA });
    }
    // declared totalBytes cannot equal the true sum (sum is not a safe integer);
    // use a safe-integer placeholder — implementation must fail on sum overflow first.
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files,
          integrity: {
            algorithm: 'sha256',
            totalBytes: Number.MAX_SAFE_INTEGER,
            entries,
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects canonical JSON UTF-8 payloads larger than 8MiB with bounded construction', () => {
    // ~5k × ~900-byte unique paths → JSON well over 8MiB without approaching file-count cap
    const n = 5000;
    const pad = 'p'.repeat(880);
    /** @type {string[]} */
    const files = [];
    /** @type {{ path: string, size: number, sha256: string }[]} */
    const entries = [];
    for (let i = 0; i < n; i += 1) {
      const path = `${String(i).padStart(4, '0')}_${pad}.txt`;
      assert.ok(Buffer.byteLength(path, 'utf8') <= 1024);
      files.push(path);
      entries.push({ path, size: 0, sha256: ZERO_SHA });
    }
    // Prove the serialized shape would exceed the limit if accepted.
    const roughJsonBytes =
      Buffer.byteLength(JSON.stringify({ files, entries }), 'utf8');
    assert.ok(
      roughJsonBytes > UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES,
      `fixture too small: ${roughJsonBytes}`,
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({
          files,
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries,
          },
        }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('rejects oversize lower-bound before sort-cache Buffer.from (depth defense)', () => {
    // Same class of fixture: definite path-string lower bound exceeds 8MiB before sort.
    const n = 5000;
    const pad = 'p'.repeat(880);
    /** @type {string[]} */
    const files = [];
    /** @type {{ path: string, size: number, sha256: string }[]} */
    const entries = [];
    for (let i = 0; i < n; i += 1) {
      const path = `${String(i).padStart(4, '0')}_${pad}.txt`;
      files.push(path);
      entries.push({ path, size: 0, sha256: ZERO_SHA });
    }

    const originalFrom = Buffer.from;
    let fromCalls = 0;
    // Synchronous-only patch; restore in finally (no concurrent tests here).
    Buffer.from = function patchedFrom(...args) {
      fromCalls += 1;
      return originalFrom.apply(this, args);
    };
    try {
      expectManifestInvalid(() =>
        projectCanonicalUploadManifest(
          baseInput({
            files,
            integrity: {
              algorithm: 'sha256',
              totalBytes: 0,
              entries,
            },
          }),
          { authenticatedDeviceId: DEVICE_ID },
        ),
      );
      assert.strictEqual(
        fromCalls,
        0,
        'sort-cache Buffer.from must not run after early 8MiB lower-bound reject',
      );
    } finally {
      Buffer.from = originalFrom;
    }
  });

  it('accepts exact hostname 255 UTF-8 bytes and sourcePath 4096 UTF-8 bytes', () => {
    const hostname = 'h'.repeat(UPLOAD_MANIFEST_LIMITS.MAX_HOSTNAME_UTF8_BYTES);
    const sourcePath = 's'.repeat(UPLOAD_MANIFEST_LIMITS.MAX_SOURCE_PATH_UTF8_BYTES);
    assert.strictEqual(Buffer.byteLength(hostname, 'utf8'), 255);
    assert.strictEqual(Buffer.byteLength(sourcePath, 'utf8'), 4096);
    const { manifest } = projectCanonicalUploadManifest(
      baseInput({ hostname, sourcePath }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.strictEqual(manifest.hostname, hostname);
    assert.strictEqual(manifest.sourcePath, sourcePath);

    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({ hostname: `${hostname}x` }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(
        baseInput({ sourcePath: `${sourcePath}x` }),
        { authenticatedDeviceId: DEVICE_ID },
      ),
    );
  });

  it('accepts emoji path in full projection with UTF-8 byte sort', () => {
    const emoji = '😀.txt';
    const plain = 'a.txt';
    const { manifest } = projectCanonicalUploadManifest(
      baseInput({
        files: [emoji, plain],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 0,
          entries: [
            { path: emoji, size: 0, sha256: ZERO_SHA },
            { path: plain, size: 0, sha256: ZERO_SHA },
          ],
        },
      }),
      { authenticatedDeviceId: DEVICE_ID },
    );
    assert.deepStrictEqual(manifest.files, sortedByUtf8Bytes([emoji, plain]));
  });

  it('rejects options that are non-plain, have extra keys, symbols, or accessors', () => {
    let getterCalls = 0;
    class OptionsClass {
      constructor() {
        this.authenticatedDeviceId = DEVICE_ID;
      }
    }
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), null),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), []),
    );
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), new OptionsClass()),
    );
    // Extra own options key is rejected (exact-key options only).
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), {
        authenticatedDeviceId: DEVICE_ID,
        extra: true,
      }),
    );
    const withSymbol = { authenticatedDeviceId: DEVICE_ID };
    Object.defineProperty(withSymbol, Symbol('x'), {
      enumerable: true,
      value: 1,
    });
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), withSymbol),
    );

    const hostileOpts = {};
    Object.defineProperty(hostileOpts, 'authenticatedDeviceId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return DEVICE_ID;
      },
    });
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), hostileOpts),
    );
    assert.strictEqual(getterCalls, 0, 'options getter must not be invoked');

    const claimGetter = { authenticatedDeviceId: DEVICE_ID };
    let claimGets = 0;
    Object.defineProperty(claimGetter, 'claimedManifestDigest', {
      enumerable: true,
      get() {
        claimGets += 1;
        return '0'.repeat(64);
      },
    });
    expectManifestInvalid(() =>
      projectCanonicalUploadManifest(baseInput(), claimGetter),
    );
    assert.strictEqual(claimGets, 0);
  });

  it('accepts Object.create(null) options with exact keys only', () => {
    const opts = Object.create(null);
    opts.authenticatedDeviceId = DEVICE_ID;
    const { manifestDigest } = projectCanonicalUploadManifest(baseInput(), opts);
    assert.match(manifestDigest, /^[a-f0-9]{64}$/);
  });
});
