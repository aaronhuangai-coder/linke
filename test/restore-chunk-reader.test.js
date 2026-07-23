/**
 * RED tests for G0c C5.5 restore chunk reader (real bounded snapshot range reads).
 * Authority: design docs/superpowers/specs/2026-07-23-linke-v142-g0c-c55-chunk-reader-design.md
 *           + plan docs/superpowers/plans/2026-07-23-linke-v142-g0c-c55-chunk-reader.md
 *
 * Production module intentionally absent at RED → ERR_MODULE_NOT_FOUND.
 * Behavioral tests only: no placeholder/skip/todo/weak asserts. No src changes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import {
  createRestoreSnapshotReader,
  RESTORE_CHUNK_SIZE_BYTES,
} from '../src/restore-snapshot-reader.js';
import { createRestoreTaskStore } from '../src/restore-task-store.js';
import { createRestoreChunkReader } from '../src/restore-chunk-reader.js';
import { getSnapshotManifest, safeDevicePath } from '../src/storage.js';
import { openSafeRootRelativeRead } from '../src/safe-data-files.js';

const DEVICE_A = 'device-alpha-001';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440010';
const SNAPSHOT_REMOTE = '660e8400-e29b-41d4-a716-446655440020';
const T0 = '2026-07-23T12:00:00.000Z';
const TARGET_A = 'docs/restore-target';
const CHUNK = 8_388_608;
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const READER_SURFACE = Object.freeze(['readChunk']);
const READ_RESULT_KEYS = Object.freeze(['body', 'chunkOffset', 'chunkSize']);

/** @type {string | undefined} */
let dataDir;

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, `expected LinkeError, got ${error}`);
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
    ...Object.keys(/** @type {object} */ (error)).map((k) =>
      String(/** @type {Record<string, unknown>} */ (error)[k]),
    ),
  ].join('\0');
  // Never include stack / errno / path / token in public serializable surface
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (error), 'stack')
    || !publicParts.includes('at '), 'public fields must not echo stack frames');
  const denylist = [
    ...(opts.leakTokens ?? []),
    dataDir ?? '',
    '/Users/',
    'secret-token',
    'ENOENT',
    'EACCES',
    'ELOOP',
    'EISDIR',
    'errno',
    'PROXY_SENTINEL',
    'GETTER_SENTINEL',
  ].filter(Boolean);
  for (const token of denylist) {
    if (String(token).length < 2) continue;
    // Registered code strings may legitimately equal the code itself
    if (code.includes(String(token))) continue;
    assert.ok(!publicParts.includes(String(token)), `must not leak ${token}`);
  }
  // Stack property may exist on Error but must not appear in message/code
  assert.equal(error.message, code);
  if (error.stack) {
    // Message line is "LinkeError: <code>" only — no path/token
    const firstLine = String(error.stack).split('\n')[0] ?? '';
    for (const token of opts.leakTokens ?? []) {
      if (!token || token.length < 2) continue;
      assert.ok(!firstLine.includes(token), `stack first line must not leak ${token}`);
    }
  }
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
async function expectCode(fn, code, opts = {}) {
  await assert.rejects(fn, (error) => {
    assertLinkeCode(error, code, opts);
    return true;
  });
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256Str(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Minimal frozen descriptor matching resolveChunkRead contract.
 * @param {Partial<{
 *   deviceId: string,
 *   taskId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   fileIndex: number,
 *   chunkIndex: number,
 *   path: string,
 *   fileSize: number,
 *   fileSha256: string,
 *   chunkCount: number,
 *   chunkOffset: number,
 *   chunkSize: number,
 * }>} [overrides]
 */
function makeDescriptor(overrides = {}) {
  const fileSize = overrides.fileSize ?? CHUNK + 100;
  const chunkIndex = overrides.chunkIndex ?? 0;
  const chunkCount =
    overrides.chunkCount
    ?? (fileSize === 0 ? 0 : Math.ceil(fileSize / CHUNK));
  const chunkOffset = overrides.chunkOffset ?? chunkIndex * CHUNK;
  const remaining = fileSize - chunkOffset;
  const chunkSize =
    overrides.chunkSize ?? (remaining >= CHUNK ? CHUNK : Math.max(remaining, 0));
  return Object.freeze({
    deviceId: overrides.deviceId ?? DEVICE_A,
    taskId: overrides.taskId ?? 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
    snapshotId: overrides.snapshotId ?? SNAPSHOT_A,
    manifestDigest:
      overrides.manifestDigest
      ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fileIndex: overrides.fileIndex ?? 0,
    chunkIndex,
    path: overrides.path ?? 'docs/big.bin',
    fileSize,
    fileSha256:
      overrides.fileSha256
      ?? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    chunkCount,
    chunkOffset,
    chunkSize,
  });
}

/**
 * @param {object} readable
 */
function makeAssertReadable(readable, opts = {}) {
  /** @type {{ deviceId: string, snapshotId: string }[]} */
  const calls = [];
  return {
    calls,
    get callCount() {
      return calls.length;
    },
    assertSnapshotReadable: async (deviceId, snapshotId) => {
      calls.push({ deviceId, snapshotId });
      if (opts.throwError !== undefined) throw opts.throwError;
      if (typeof opts.impl === 'function') return opts.impl(deviceId, snapshotId);
      return JSON.parse(JSON.stringify(readable));
    },
  };
}

/**
 * Build assertSnapshotReadable result shape from files.
 * @param {{
 *   manifestDigest?: string,
 *   files: { path: string, size: number, sha256: string }[],
 * }} opts
 */
function makeReadableResult(opts) {
  const files = opts.files.map((f, i) =>
    Object.freeze({
      fileIndex: i,
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      chunkCount: f.size === 0 ? 0 : Math.ceil(f.size / CHUNK),
    }),
  );
  return Object.freeze({
    manifestDigest:
      opts.manifestDigest
      ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    files: Object.freeze(files),
  });
}

/**
 * Assert every recorded handle.read stays inside the descriptor chunk window and
 * cumulative bytesRead equals chunkSize exactly (bounded range-read evidence).
 * @param {{ position: number, length: number, bytesRead: number }[]} readCalls
 * @param {number} chunkOffset
 * @param {number} chunkSize
 */
function assertReadsWithinChunkWindow(readCalls, chunkOffset, chunkSize) {
  assert.ok(Array.isArray(readCalls) && readCalls.length >= 1, 'must issue ≥1 read');
  let total = 0;
  const windowEnd = chunkOffset + chunkSize;
  for (const call of readCalls) {
    assert.equal(typeof call.position, 'number');
    assert.equal(typeof call.length, 'number');
    assert.equal(typeof call.bytesRead, 'number');
    assert.ok(
      Number.isSafeInteger(call.position) && call.position >= chunkOffset,
      `read position ${call.position} must be ≥ chunkOffset ${chunkOffset}`,
    );
    assert.ok(
      call.position < windowEnd,
      `read position ${call.position} must be < window end ${windowEnd}`,
    );
    assert.ok(
      call.length >= 0 && call.position + call.length <= windowEnd,
      `read length ${call.length} at ${call.position} must stay within chunk window`,
    );
    assert.ok(
      call.bytesRead >= 0 && call.position + call.bytesRead <= windowEnd,
      `bytesRead ${call.bytesRead} at ${call.position} must stay within chunk window`,
    );
    total += call.bytesRead;
  }
  assert.equal(total, chunkSize, 'cumulative bytesRead must equal chunkSize exactly');
}

/**
 * Fake openSafeRootRelativeRead that records calls and can simulate fd behavior.
 * @param {{
 *   content?: Buffer,
 *   size?: number,
 *   openError?: unknown,
 *   closeError?: unknown,
 *   firstStat?: object,
 *   secondStat?: object | (() => object),
 *   readPlan?: Array<'short' | 'full' | 'zero' | 'over' | number>,
 *   onOpen?: (args: { root: string, relativePath: string }) => void,
 * }} [opts]
 */
function makeOpenFake(opts = {}) {
  /** @type {{ root: string, relativePath: string }[]} */
  const openCalls = [];
  /** @type {{ position: number, length: number, bytesRead: number }[]} */
  const readCalls = [];
  /** @type {number} */
  let closeCount = 0;
  /** @type {boolean} */
  let currentlyOpen = false;
  /** @type {number} */
  let readStep = 0;

  const content = opts.content ?? Buffer.alloc(0);
  const size = opts.size ?? content.length;

  /**
   * @param {number} position
   * @param {number} length
   * @param {number} bytesRead
   */
  function recordRead(position, length, bytesRead) {
    readCalls.push({
      position: Number(position) || 0,
      length: Number(length) || 0,
      bytesRead: Number(bytesRead) || 0,
    });
  }

  const openFn = async (root, relativePath) => {
    openCalls.push({ root, relativePath });
    if (opts.onOpen) opts.onOpen({ root, relativePath });
    if (opts.openError !== undefined) throw opts.openError;

    currentlyOpen = true;
    let closed = false;
    const firstStat = {
      isFile: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      size,
      dev: 1,
      ino: 100,
      mode: 0o100600,
      ...(opts.firstStat ?? {}),
    };
    // Ensure methods exist even when overridden partially
    if (typeof firstStat.isFile !== 'function') firstStat.isFile = () => true;
    if (typeof firstStat.isSymbolicLink !== 'function') {
      firstStat.isSymbolicLink = () => false;
    }

    /** @type {{ fd: number, close: Function, stat: Function, read: Function }} */
    const handle = {
      fd: 77,
      close: async () => {
        if (closed) return;
        closed = true;
        currentlyOpen = false;
        closeCount += 1;
        if (opts.closeError !== undefined) throw opts.closeError;
      },
      stat: async () => {
        // First call after open: firstStat; subsequent: secondStat or firstStat
        if (handle._statCalls === 0) {
          handle._statCalls = 1;
          return {
            ...firstStat,
            isFile: firstStat.isFile,
            isSymbolicLink: firstStat.isSymbolicLink,
            isDirectory: firstStat.isDirectory ?? (() => false),
          };
        }
        handle._statCalls += 1;
        const raw =
          typeof opts.secondStat === 'function'
            ? opts.secondStat()
            : (opts.secondStat ?? firstStat);
        return {
          isFile: raw.isFile ?? (() => true),
          isSymbolicLink: raw.isSymbolicLink ?? (() => false),
          isDirectory: raw.isDirectory ?? (() => false),
          size: raw.size ?? size,
          dev: raw.dev ?? firstStat.dev,
          ino: raw.ino ?? firstStat.ino,
          mode: raw.mode ?? firstStat.mode,
        };
      },
      _statCalls: 0,
      read: async (buf, offset, length, position) => {
        const plan = opts.readPlan;
        if (plan && readStep < plan.length) {
          const step = plan[readStep];
          readStep += 1;
          if (step === 'zero') {
            recordRead(position, length, 0);
            return { bytesRead: 0 };
          }
          if (step === 'over') {
            // Write one extra byte beyond requested length into a larger window
            const n = length + 1;
            // Node FileHandle.read cannot legally over-read into length; simulate by
            // returning length+1 which production must treat as integrity failure.
            recordRead(position, length, n);
            return { bytesRead: n };
          }
          if (step === 'short') {
            // Legitimate short-read must always advance when source is available:
            // length>1 → length-1; length===1 with bytes left → 1.
            // Explicit 'zero' (not 'short') remains the early-EOF case (bytesRead 0).
            const srcStart = Number(position) || 0;
            const available = Math.max(0, content.length - srcStart);
            const n =
              length > 1
                ? length - 1
                : length === 1 && available > 0
                  ? 1
                  : 0;
            const slice = content.subarray(srcStart, srcStart + n);
            slice.copy(buf, offset);
            recordRead(position, length, n);
            return { bytesRead: n };
          }
          if (typeof step === 'number') {
            const n = Math.min(step, length);
            const srcStart = Number(position) || 0;
            content.subarray(srcStart, srcStart + n).copy(buf, offset);
            recordRead(position, length, n);
            return { bytesRead: n };
          }
          // 'full'
        }
        const srcStart = Number(position) || 0;
        const available = Math.max(0, content.length - srcStart);
        const n = Math.min(length, available);
        content.subarray(srcStart, srcStart + n).copy(buf, offset);
        recordRead(position, length, n);
        return { bytesRead: n };
      },
    };

    return {
      handle,
      size,
      absolutePath: join(String(root), String(relativePath)),
    };
  };

  return {
    openFn,
    openCalls,
    readCalls,
    get closeCount() {
      return closeCount;
    },
    get currentlyOpen() {
      return currentlyOpen;
    },
    resetReadStep() {
      readStep = 0;
    },
    clearReadCalls() {
      readCalls.length = 0;
    },
  };
}

/**
 * @param {object} opts
 */
function openReader(opts) {
  return createRestoreChunkReader({
    dataDir: opts.dataDir ?? dataDir,
    taskStore: opts.taskStore,
    snapshotReader: opts.snapshotReader,
    openSafeRootRelativeReadFn: opts.openSafeRootRelativeReadFn,
    safeDevicePathFn: opts.safeDevicePathFn,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-rcr-'));
});

afterEach(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

// ── 1. factory surface ─────────────────────────────────────────────

describe('createRestoreChunkReader factory surface', () => {
  it('returns frozen exact surface { readChunk } only', () => {
    const taskStore = {
      resolveChunkRead: async () => makeDescriptor(),
    };
    const snapshotReader = makeAssertReadable(
      makeReadableResult({
        files: [{ path: 'a.bin', size: 1, sha256: sha256Str('x') }],
      }),
    );
    const reader = openReader({
      taskStore,
      snapshotReader,
      openSafeRootRelativeReadFn: makeOpenFake().openFn,
    });
    assert.ok(Object.isFrozen(reader));
    assert.deepEqual(Object.keys(reader).sort(), [...READER_SURFACE]);
    assert.equal(typeof reader.readChunk, 'function');
    assert.throws(() => {
      /** @type {Record<string, unknown>} */ (reader).extra = 1;
    }, TypeError);
    // No HTTP / store / open leakage on surface
    for (const banned of [
      'resolveChunkRead',
      'assertSnapshotReadable',
      'handle',
      'router',
      'openSafeRootRelativeRead',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(reader, banned), false);
    }
  });
});

// ── 2. resolve + manifest recheck before open ──────────────────────

describe('readChunk — resolveChunkRead + manifest recheck; drift → integrity-failed, no open', () => {
  it('forwards resolveChunkRead LinkeError exactly and never opens', async () => {
    const original = new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
    /** @type {unknown[]} */
    const resolveCalls = [];
    const taskStore = {
      resolveChunkRead: async (input) => {
        resolveCalls.push(input);
        throw original;
      },
    };
    const snapshotReader = makeAssertReadable(
      makeReadableResult({
        files: [{ path: 'a.bin', size: CHUNK, sha256: 'c'.repeat(64) }],
      }),
    );
    const openFake = makeOpenFake();
    const reader = openReader({
      taskStore,
      snapshotReader,
      openSafeRootRelativeReadFn: openFake.openFn,
    });

    await assert.rejects(
      () =>
        reader.readChunk({
          deviceId: DEVICE_A,
          taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => {
        assert.equal(err, original, 'must rethrow exact same LinkeError object');
        return true;
      },
    );
    assert.equal(resolveCalls.length, 1);
    assert.equal(snapshotReader.callCount, 0, 'must not assertSnapshotReadable after resolve fail');
    assert.equal(openFake.openCalls.length, 0, 'must not open after resolve fail');
  });

  it('calls assertSnapshotReadable and rejects digest/file metadata drift without open', async () => {
    const desc = makeDescriptor({
      path: 'docs/big.bin',
      fileSize: CHUNK + 100,
      fileSha256: 'b'.repeat(64),
      chunkCount: 2,
      chunkIndex: 0,
      chunkOffset: 0,
      chunkSize: CHUNK,
      manifestDigest: 'a'.repeat(64),
      fileIndex: 0,
    });

    const driftCases = [
      {
        name: 'manifestDigest',
        readable: makeReadableResult({
          manifestDigest: 'f'.repeat(64),
          files: [
            {
              path: desc.path,
              size: desc.fileSize,
              sha256: desc.fileSha256,
            },
          ],
        }),
      },
      {
        name: 'path',
        readable: makeReadableResult({
          manifestDigest: desc.manifestDigest,
          files: [
            {
              path: 'docs/other.bin',
              size: desc.fileSize,
              sha256: desc.fileSha256,
            },
          ],
        }),
      },
      {
        name: 'size',
        readable: makeReadableResult({
          manifestDigest: desc.manifestDigest,
          files: [
            {
              path: desc.path,
              size: desc.fileSize + 1,
              sha256: desc.fileSha256,
            },
          ],
        }),
      },
      {
        name: 'sha256',
        readable: makeReadableResult({
          manifestDigest: desc.manifestDigest,
          files: [
            {
              path: desc.path,
              size: desc.fileSize,
              sha256: 'c'.repeat(64),
            },
          ],
        }),
      },
      {
        name: 'chunkCount',
        readable: makeReadableResult({
          manifestDigest: desc.manifestDigest,
          files: [
            {
              path: desc.path,
              // size that yields different chunkCount (3 vs 2)
              size: CHUNK * 2 + 1,
              sha256: desc.fileSha256,
            },
          ],
        }),
      },
      {
        name: 'fileIndex missing / wrong index entry',
        readable: makeReadableResult({
          manifestDigest: desc.manifestDigest,
          files: [
            {
              path: 'other/first.bin',
              size: 1,
              sha256: 'd'.repeat(64),
            },
            {
              path: desc.path,
              size: desc.fileSize,
              sha256: desc.fileSha256,
            },
          ],
        }),
        // fileIndex 0 points at other/first.bin → path/size/sha drift
      },
    ];

    for (const tc of driftCases) {
      const openFake = makeOpenFake({
        content: Buffer.alloc(CHUNK, 7),
      });
      const snapshotReader = makeAssertReadable(tc.readable);
      const taskStore = {
        resolveChunkRead: async () => desc,
      };
      const reader = openReader({
        taskStore,
        snapshotReader,
        openSafeRootRelativeReadFn: openFake.openFn,
      });

      await expectCode(
        () =>
          reader.readChunk({
            deviceId: desc.deviceId,
            taskId: desc.taskId,
            fileIndex: desc.fileIndex,
            chunkIndex: desc.chunkIndex,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        {
          statusCode: 422,
          retryable: false,
          leakTokens: [desc.path, 'docs/other.bin', dataDir ?? ''],
        },
      );
      assert.ok(snapshotReader.callCount >= 1, `${tc.name}: must recheck manifest`);
      assert.equal(openFake.openCalls.length, 0, `${tc.name}: must not open on drift`);
      assert.equal(openFake.closeCount, 0, `${tc.name}: no fd to close`);
    }
  });

  it('on matching manifest, opens via injected open with controller-internal relative path only', async () => {
    const body = Buffer.alloc(CHUNK, 0xab);
    const fileSha = sha256Buf(body);
    const desc = makeDescriptor({
      path: 'nested/data.bin',
      fileSize: CHUNK,
      fileSha256: fileSha,
      chunkCount: 1,
      chunkIndex: 0,
      chunkOffset: 0,
      chunkSize: CHUNK,
      manifestDigest: 'a'.repeat(64),
    });
    const readable = makeReadableResult({
      manifestDigest: desc.manifestDigest,
      files: [{ path: desc.path, size: desc.fileSize, sha256: fileSha }],
    });
    const openFake = makeOpenFake({ content: body, size: body.length });
    /** @type {string[]} */
    const safePathCalls = [];
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: makeAssertReadable(readable),
      openSafeRootRelativeReadFn: openFake.openFn,
      safeDevicePathFn: (dd, deviceId) => {
        safePathCalls.push(deviceId);
        return safeDevicePath(dd, deviceId);
      },
    });

    const result = await reader.readChunk({
      deviceId: desc.deviceId,
      taskId: desc.taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });

    assert.deepEqual(Object.keys(result).sort(), [...READ_RESULT_KEYS].sort());
    assert.ok(Buffer.isBuffer(result.body));
    assert.equal(result.body.length, CHUNK);
    assert.deepEqual(result.body, body);
    assert.equal(result.chunkOffset, 0);
    assert.equal(result.chunkSize, CHUNK);
    assert.equal(openFake.openCalls.length, 1);
    assert.equal(openFake.closeCount, 1, 'success path must close fd');
    assert.equal(openFake.currentlyOpen, false);

    const openedRel = openFake.openCalls[0].relativePath;
    assert.equal(typeof openedRel, 'string');
    // Controller-internal: repo/devices/<slug>/snapshots/<id>/files/<safe path>
    assert.match(
      openedRel,
      /^repo\/devices\/[^/]+\/snapshots\/[0-9a-f-]+\/files\/nested\/data\.bin$/,
    );
    assert.ok(!openedRel.includes('..'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'absolutePath'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'path'));
    assert.ok(safePathCalls.includes(desc.deviceId));
    // Result must not leak dataDir / path
    const blob = JSON.stringify({
      chunkOffset: result.chunkOffset,
      chunkSize: result.chunkSize,
    });
    assert.ok(!blob.includes(/** @type {string} */ (dataDir)));
  });
});

// ── 3. injected open fake: read / fstat / error sanitization ───────

describe('readChunk — injected openSafeRootRelativeRead behavioral matrix', () => {
  function matchingPair(content, path = 'f.bin') {
    const fileSha = sha256Buf(content);
    const fileSize = content.length;
    const chunkCount = fileSize === 0 ? 0 : Math.ceil(fileSize / CHUNK);
    const desc = makeDescriptor({
      path,
      fileSize,
      fileSha256: fileSha,
      chunkCount,
      chunkIndex: 0,
      chunkOffset: 0,
      chunkSize: fileSize > CHUNK ? CHUNK : fileSize,
      manifestDigest: 'a'.repeat(64),
    });
    const readable = makeReadableResult({
      manifestDigest: desc.manifestDigest,
      files: [{ path, size: fileSize, sha256: fileSha }],
    });
    return { desc, readable };
  }

  it('success: full 8 MiB chunk and tail chunk; closes on success', async () => {
    // Full 8 MiB
    const full = Buffer.alloc(CHUNK, 0x11);
    {
      const { desc, readable } = matchingPair(full, 'full8.bin');
      const openFake = makeOpenFake({ content: full, size: full.length });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      const res = await reader.readChunk({
        deviceId: DEVICE_A,
        taskId: desc.taskId,
        fileIndex: 0,
        chunkIndex: 0,
      });
      assert.equal(res.chunkSize, CHUNK);
      assert.equal(res.body.length, CHUNK);
      assert.deepEqual(res.body, full);
      assert.equal(openFake.closeCount, 1);
    }

    // Tail: CHUNK + 42 → chunk 1 size 42
    const combined = Buffer.alloc(CHUNK + 42, 0x22);
    combined[CHUNK] = 0x99;
    combined[CHUNK + 41] = 0x88;
    const fileSha = sha256Buf(combined);
    const desc = makeDescriptor({
      path: 'tail.bin',
      fileSize: combined.length,
      fileSha256: fileSha,
      chunkCount: 2,
      chunkIndex: 1,
      chunkOffset: CHUNK,
      chunkSize: 42,
      manifestDigest: 'a'.repeat(64),
    });
    const readable = makeReadableResult({
      manifestDigest: desc.manifestDigest,
      files: [{ path: 'tail.bin', size: combined.length, sha256: fileSha }],
    });
    const openFake = makeOpenFake({ content: combined, size: combined.length });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: makeAssertReadable(readable),
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    const res = await reader.readChunk({
      deviceId: DEVICE_A,
      taskId: desc.taskId,
      fileIndex: 0,
      chunkIndex: 1,
    });
    assert.equal(res.chunkOffset, CHUNK);
    assert.equal(res.chunkSize, 42);
    assert.equal(res.body.length, 42);
    assert.deepEqual(res.body, combined.subarray(CHUNK, CHUNK + 42));
    assert.equal(openFake.closeCount, 1);
    assert.equal(openFake.currentlyOpen, false);
  });

  it('short reads continue until complete; early EOF / over-read → integrity-failed + close', async () => {
    const content = Buffer.alloc(1000, 0x33);
    const { desc, readable } = matchingPair(content, 'short.bin');

    // Short reads that eventually complete
    {
      const openFake = makeOpenFake({
        content,
        size: content.length,
        readPlan: ['short', 'short', 'full'],
      });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      const res = await reader.readChunk({
        deviceId: DEVICE_A,
        taskId: desc.taskId,
        fileIndex: 0,
        chunkIndex: 0,
      });
      assert.equal(res.body.length, 1000);
      assert.deepEqual(res.body, content);
      assert.equal(openFake.closeCount, 1);
    }

    // Early EOF (bytesRead 0 before filled)
    {
      const openFake = makeOpenFake({
        content,
        size: content.length,
        readPlan: ['short', 'zero'],
      });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await expectCode(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        { statusCode: 422, leakTokens: [desc.path, dataDir ?? '', 'ENOENT'] },
      );
      assert.equal(openFake.closeCount, 1, 'early EOF must close');
      assert.equal(openFake.currentlyOpen, false);
    }

    // Over-read (bytesRead > remaining request)
    {
      const openFake = makeOpenFake({
        content,
        size: content.length,
        readPlan: ['over'],
      });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await expectCode(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        { statusCode: 422 },
      );
      assert.equal(openFake.closeCount, 1, 'over-read must close');
    }
  });

  it('size mismatch (open size ≠ manifest fileSize) → integrity-failed + close', async () => {
    const content = Buffer.alloc(500, 0x44);
    const { desc, readable } = matchingPair(content, 'size.bin');
    const openFake = makeOpenFake({
      content,
      size: 499, // lie about size from open
    });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: makeAssertReadable(readable),
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    await expectCode(
      () =>
        reader.readChunk({
          deviceId: DEVICE_A,
          taskId: desc.taskId,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [desc.path] },
    );
    // Open may return handle then first fstat fails — must still close
    assert.equal(openFake.closeCount, 1);
    assert.equal(openFake.currentlyOpen, false);
  });

  it('second fstat dev/ino/size/mode change → integrity-failed + close', async () => {
    const content = Buffer.alloc(200, 0x55);
    const { desc, readable } = matchingPair(content, 'race.bin');

    const changes = [
      { name: 'dev', secondStat: { dev: 999, ino: 100, size: 200, mode: 0o100600 } },
      { name: 'ino', secondStat: { dev: 1, ino: 999, size: 200, mode: 0o100600 } },
      { name: 'size', secondStat: { dev: 1, ino: 100, size: 199, mode: 0o100600 } },
      { name: 'mode', secondStat: { dev: 1, ino: 100, size: 200, mode: 0o100644 } },
    ];

    for (const ch of changes) {
      const openFake = makeOpenFake({
        content,
        size: content.length,
        firstStat: { dev: 1, ino: 100, size: 200, mode: 0o100600 },
        secondStat: ch.secondStat,
      });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await expectCode(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        {
          statusCode: 422,
          leakTokens: [desc.path, String(ch.secondStat.dev), String(ch.secondStat.ino)],
        },
      );
      assert.equal(openFake.closeCount, 1, `${ch.name} change must close`);
      assert.equal(openFake.currentlyOpen, false, `${ch.name} must not leak open fd`);
    }
  });

  it('symlink / directory / bare ENOENT sanitize to integrity-failed; close when handle was opened', async () => {
    const content = Buffer.alloc(50, 0x66);
    const { desc, readable } = matchingPair(content, 'hostile.bin');
    const leakPath = `${dataDir}/repo/devices/x/snapshots/y/files/hostile.bin`;
    const leakToken = 'secret-token-xyz';

    // Bare ENOENT from open (openSafeRootRelativeRead contract)
    {
      const enoent = Object.assign(new Error(`ENOENT: no such file or directory, open '${leakPath}'`), {
        code: 'ENOENT',
        errno: -2,
        path: leakPath,
      });
      const openFake = makeOpenFake({ openError: enoent });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await expectCode(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        {
          statusCode: 422,
          leakTokens: [leakPath, leakToken, 'ENOENT', 'errno', String(-2), desc.path],
        },
      );
      assert.equal(openFake.closeCount, 0, 'open never succeeded — nothing to close');
      // Must NOT rethrow bare Error / ENOENT
      await assert.rejects(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        (err) => {
          assert.ok(err instanceof LinkeError);
          assert.equal(err.code, ERROR_CODES.RESTORE_INTEGRITY_FAILED);
          assert.notEqual(/** @type {{ code?: string }} */ (err).code, 'ENOENT');
          return true;
        },
      );
    }

    // Symlink-style SafeDataFileError / generic open failure
    {
      const openFake = makeOpenFake({
        openError: Object.assign(new Error(`ELOOP symlink ${leakPath} token=${leakToken}`), {
          code: 'ELOOP',
          path: leakPath,
        }),
      });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await expectCode(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        {
          statusCode: 422,
          leakTokens: [leakPath, leakToken, 'ELOOP', 'symlink'],
        },
      );
    }

    // Directory: first fstat says not a regular file
    {
      const openFake = makeOpenFake({
        content,
        size: content.length,
        firstStat: {
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          size: content.length,
          dev: 1,
          ino: 1,
          mode: 0o040755,
        },
      });
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader: makeAssertReadable(readable),
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await expectCode(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        { statusCode: 422, leakTokens: [desc.path, leakPath] },
      );
      assert.equal(openFake.closeCount, 1, 'directory fstat fail must close');
    }
  });
});

// ── 4. real local + remote-upload fixtures ─────────────────────────

describe('readChunk — real local + remote-upload committed fixtures (range + parallel)', () => {
  /**
   * Plant local schemaVersion-2 snapshot under dataDir (no remote origin).
   * @param {{
   *   deviceId: string,
   *   snapshotId: string,
   *   files: { path: string, content: Buffer }[],
   * }} opts
   */
  async function plantLocalSnapshot(opts) {
    const { deviceRel } = safeDevicePath(/** @type {string} */ (dataDir), opts.deviceId);
    const base = join(/** @type {string} */ (dataDir), deviceRel, 'snapshots', opts.snapshotId);
    await mkdir(join(base, 'files'), { recursive: true });

    /** @type {{ path: string, size: number, sha256: string }[]} */
    const entries = [];
    /** @type {string[]} */
    const filesList = [];
    let totalBytes = 0;
    for (const f of opts.files) {
      const abs = join(base, 'files', f.path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, f.content);
      const sha = sha256Buf(f.content);
      entries.push({ path: f.path, size: f.content.length, sha256: sha });
      filesList.push(f.path);
      totalBytes += f.content.length;
    }
    // UTF-8 path order for remote-style integrity; local projector will reorder.
    const sorted = [...entries].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
    );
    const manifest = {
      schemaVersion: 2,
      snapshotId: opts.snapshotId,
      deviceId: opts.deviceId,
      createdAt: T0,
      hostname: 'local-host.example',
      ipAddress: '192.0.2.10',
      sourcePath: '/tmp/backup-source',
      files: sorted.map((e) => e.path),
      integrity: {
        algorithm: 'sha256',
        totalBytes,
        entries: sorted,
      },
    };
    await writeFile(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // Local index entry (no origin)
    const indexPath = join(/** @type {string} */ (dataDir), deviceRel, 'snapshots.json');
    let list = [];
    try {
      list = JSON.parse(await readFile(indexPath, 'utf8'));
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    list = list.filter((e) => e && e.snapshotId !== opts.snapshotId);
    list.push({
      snapshotId: opts.snapshotId,
      createdAt: T0,
      fileCount: sorted.length,
      totalBytes,
    });
    await mkdir(join(/** @type {string} */ (dataDir), deviceRel), { recursive: true });
    await writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');

    return { manifest, entries: sorted, totalBytes, base };
  }

  /**
   * Plant remote-upload committed snapshot (COMPLETED + index + canonical digest).
   * @param {{
   *   deviceId: string,
   *   snapshotId: string,
   *   files: { path: string, content: Buffer }[],
   * }} opts
   */
  async function plantRemoteCommitted(opts) {
    const { deviceRel } = safeDevicePath(/** @type {string} */ (dataDir), opts.deviceId);
    const base = join(/** @type {string} */ (dataDir), deviceRel, 'snapshots', opts.snapshotId);
    await mkdir(join(base, 'files'), { recursive: true });

    /** @type {{ path: string, size: number, sha256: string }[]} */
    const entries = [];
    let totalBytes = 0;
    for (const f of opts.files) {
      const abs = join(base, 'files', f.path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, f.content);
      entries.push({
        path: f.path,
        size: f.content.length,
        sha256: sha256Buf(f.content),
      });
      totalBytes += f.content.length;
    }
    const sorted = [...entries].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
    );
    const manifest = {
      schemaVersion: 2,
      snapshotId: opts.snapshotId,
      deviceId: opts.deviceId,
      createdAt: T0,
      files: sorted.map((e) => e.path),
      integrity: {
        algorithm: 'sha256',
        totalBytes,
        entries: sorted,
      },
    };
    // Digest authority: sha256(JSON.stringify(canonical)) — compact JSON order.
    const { manifest: canonical, manifestDigest } = projectCanonicalUploadManifest(manifest, {
      authenticatedDeviceId: opts.deviceId,
    });
    // Wire digest must match projector (re-project from clean)
    const wireDigest = createHash('sha256')
      .update(JSON.stringify(canonical), 'utf8')
      .digest('hex');
    assert.equal(manifestDigest, wireDigest);

    await writeFile(join(base, 'manifest.json'), JSON.stringify(canonical), 'utf8');
    await writeFile(
      join(base, 'COMPLETED.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          origin: 'remote-upload',
          snapshotId: opts.snapshotId,
          manifestDigest,
          committedAt: T0,
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000099',
          deviceId: opts.deviceId,
        },
        null,
        2,
      ),
      'utf8',
    );

    const indexPath = join(/** @type {string} */ (dataDir), deviceRel, 'snapshots.json');
    let list = [];
    try {
      list = JSON.parse(await readFile(indexPath, 'utf8'));
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    list = list.filter((e) => e && e.snapshotId !== opts.snapshotId);
    list.push({
      snapshotId: opts.snapshotId,
      origin: 'remote-upload',
      manifestDigest,
      committedAt: T0,
    });
    await mkdir(join(/** @type {string} */ (dataDir), deviceRel), { recursive: true });
    await writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');

    return { manifestDigest, canonical, entries: sorted, totalBytes, base };
  }

  it('local fixture: 8 MiB + tail range reads; parallel readonly; no per-chunk full-file hash', async () => {
    // CHUNK + 77 → 2 chunks
    const content = Buffer.alloc(CHUNK + 77, 0x71);
    for (let i = 0; i < 77; i += 1) content[CHUNK + i] = i & 0xff;

    await plantLocalSnapshot({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      files: [
        { path: 'z-last.txt', content: Buffer.from('tiny') },
        { path: 'a-big.bin', content },
      ],
    });

    // Production snapshot reader + task store + real open (default)
    const snapshotReader = createRestoreSnapshotReader({
      dataDir: /** @type {string} */ (dataDir),
      getSnapshotManifestFn: getSnapshotManifest,
    });
    const taskStore = createRestoreTaskStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: snapshotReader,
      now: () => new Date(T0),
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000011',
    });

    // Instrument open handle.read: record position/length/bytesRead (bounded-window evidence).
    /** @type {number} */
    let openCount = 0;
    /** @type {{ position: number, length: number, bytesRead: number }[]} */
    const readCalls = [];
    const realOpen = openSafeRootRelativeRead;
    const openWrapped = async (root, rel, deps) => {
      openCount += 1;
      const opened = await realOpen(root, rel, deps);
      const handle = opened.handle;
      const origRead = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        const result = await origRead(buffer, offset, length, position);
        readCalls.push({
          position: Number(position) || 0,
          length: Number(length) || 0,
          bytesRead: Number(result?.bytesRead) || 0,
        });
        return result;
      };
      return opened;
    };

    const reader = createRestoreChunkReader({
      dataDir: /** @type {string} */ (dataDir),
      taskStore,
      snapshotReader,
      openSafeRootRelativeReadFn: openWrapped,
    });

    const created = await taskStore.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;
    await taskStore.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });

    // Discover fileIndex for a-big.bin via resolve
    // After projector UTF-8 sort: a-big.bin before z-last.txt
    const d0 = await taskStore.resolveChunkRead({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.equal(d0.path, 'a-big.bin');
    assert.equal(d0.chunkSize, CHUNK);

    readCalls.length = 0;
    const r0 = await reader.readChunk({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.equal(r0.body.length, CHUNK);
    assert.deepEqual(r0.body, content.subarray(0, CHUNK));
    assert.equal(r0.chunkOffset, 0);
    assert.equal(r0.chunkSize, CHUNK);
    assertReadsWithinChunkWindow(readCalls, d0.chunkOffset, d0.chunkSize);

    const d1 = await taskStore.resolveChunkRead({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 1,
    });
    readCalls.length = 0;
    const r1 = await reader.readChunk({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 1,
    });
    assert.equal(r1.body.length, 77);
    assert.deepEqual(r1.body, content.subarray(CHUNK, CHUNK + 77));
    assert.equal(r1.chunkOffset, CHUNK);
    assert.equal(r1.chunkSize, 77);
    assertReadsWithinChunkWindow(readCalls, d1.chunkOffset, d1.chunkSize);

    // Parallel readonly of both chunks
    const openBeforeParallel = openCount;
    const [p0, p1] = await Promise.all([
      reader.readChunk({
        deviceId: DEVICE_A,
        taskId,
        fileIndex: 0,
        chunkIndex: 0,
      }),
      reader.readChunk({
        deviceId: DEVICE_A,
        taskId,
        fileIndex: 0,
        chunkIndex: 1,
      }),
    ]);
    assert.deepEqual(p0.body, content.subarray(0, CHUNK));
    assert.deepEqual(p1.body, content.subarray(CHUNK, CHUNK + 77));
    assert.ok(openCount >= openBeforeParallel + 2, 'each parallel read must open independently');

    // Static: production module must not import/reference full-file hash APIs.
    const readerSrc = await readFile(
      new URL('../src/restore-chunk-reader.js', import.meta.url),
      'utf8',
    );
    assert.ok(
      !readerSrc.includes('safeHashFileSha256'),
      'restore-chunk-reader must not reference safeHashFileSha256',
    );
    assert.ok(
      !/\bcreateReadStream\b/.test(readerSrc),
      'restore-chunk-reader must not use createReadStream full-file hash path',
    );
    assert.ok(
      !/safeHashFileSha256Fn/.test(readerSrc),
      'restore-chunk-reader must not accept safeHashFileSha256Fn injection',
    );

    // Service-level: body SHA is recomputed by caller, not by full file scan
    const chunkSha = sha256Buf(r0.body);
    assert.match(chunkSha, /^[a-f0-9]{64}$/);
    assert.notEqual(chunkSha, d0.fileSha256, 'chunk SHA ≠ file SHA for multi-chunk file');
  });

  it('remote-upload committed fixture: range read + parallel; no per-chunk full-file hash', async () => {
    const head = Buffer.alloc(CHUNK, 0xa1);
    const tail = Buffer.alloc(13, 0xb2);
    const content = Buffer.concat([head, tail]);

    const planted = await plantRemoteCommitted({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_REMOTE,
      files: [
        { path: 'remote/big.bin', content },
        { path: 'remote/empty.dat', content: Buffer.alloc(0) },
      ],
    });

    // Verify storage classifies as remote-readable
    const rawManifest = await getSnapshotManifest(
      /** @type {string} */ (dataDir),
      DEVICE_A,
      SNAPSHOT_REMOTE,
    );
    assert.ok(rawManifest);

    const snapshotReader = createRestoreSnapshotReader({
      dataDir: /** @type {string} */ (dataDir),
      getSnapshotManifestFn: getSnapshotManifest,
    });
    const taskStore = createRestoreTaskStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: snapshotReader,
      now: () => new Date(T0),
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000022',
    });

    /** @type {{ position: number, length: number, bytesRead: number }[]} */
    const readCalls = [];
    const realOpen = openSafeRootRelativeRead;
    const openWrapped = async (root, rel, deps) => {
      const opened = await realOpen(root, rel, deps);
      const handle = opened.handle;
      const origRead = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        const result = await origRead(buffer, offset, length, position);
        readCalls.push({
          position: Number(position) || 0,
          length: Number(length) || 0,
          bytesRead: Number(result?.bytesRead) || 0,
        });
        return result;
      };
      return opened;
    };

    const reader = createRestoreChunkReader({
      dataDir: /** @type {string} */ (dataDir),
      taskStore,
      snapshotReader,
      openSafeRootRelativeReadFn: openWrapped,
    });

    const created = await taskStore.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_REMOTE,
      relativeTarget: TARGET_A,
    });
    assert.equal(created.taskSummary.manifestDigest, planted.manifestDigest);
    const taskId = created.taskSummary.taskId;
    await taskStore.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });

    // empty.dat has chunkCount 0 — resolve must reject (task-invalid)
    // file order: remote/big.bin, remote/empty.dat (UTF-8)
    const descBig0 = await taskStore.resolveChunkRead({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.equal(descBig0.path, 'remote/big.bin');
    assert.equal(descBig0.chunkSize, CHUNK);

    const descBig1 = await taskStore.resolveChunkRead({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 1,
    });

    // Sequential window evidence first (shared parallel reads would interleave).
    readCalls.length = 0;
    const seq0 = await reader.readChunk({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.equal(seq0.body.length, CHUNK);
    assert.deepEqual(seq0.body, head);
    assertReadsWithinChunkWindow(readCalls, descBig0.chunkOffset, descBig0.chunkSize);

    readCalls.length = 0;
    const seq1 = await reader.readChunk({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 1,
    });
    assert.equal(seq1.body.length, 13);
    assert.deepEqual(seq1.body, tail);
    assertReadsWithinChunkWindow(readCalls, descBig1.chunkOffset, descBig1.chunkSize);

    const [c0, c1] = await Promise.all([
      reader.readChunk({
        deviceId: DEVICE_A,
        taskId,
        fileIndex: 0,
        chunkIndex: 0,
      }),
      reader.readChunk({
        deviceId: DEVICE_A,
        taskId,
        fileIndex: 0,
        chunkIndex: 1,
      }),
    ]);
    assert.equal(c0.body.length, CHUNK);
    assert.deepEqual(c0.body, head);
    assert.equal(c1.body.length, 13);
    assert.deepEqual(c1.body, tail);

    // Empty file still not readable via resolve
    await expectCode(
      () =>
        taskStore.resolveChunkRead({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 1,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });

  it('real open errors (missing leaf) sanitize; never leak path/errno/stack', async () => {
    // Local snapshot manifest claims a file that is missing on disk
    const content = Buffer.from('present-but-will-delete');
    await plantLocalSnapshot({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      files: [{ path: 'gone.bin', content }],
    });
    const { deviceRel } = safeDevicePath(/** @type {string} */ (dataDir), DEVICE_A);
    const leafAbs = join(
      /** @type {string} */ (dataDir),
      deviceRel,
      'snapshots',
      SNAPSHOT_A,
      'files',
      'gone.bin',
    );
    await rm(leafAbs, { force: true });

    const snapshotReader = createRestoreSnapshotReader({
      dataDir: /** @type {string} */ (dataDir),
      getSnapshotManifestFn: getSnapshotManifest,
    });
    // Task store uses mock readable so create succeeds without re-reading missing file bytes
    const fileSha = sha256Buf(content);
    const mockReadable = makeReadableResult({
      manifestDigest: 'a'.repeat(64),
      files: [{ path: 'gone.bin', size: content.length, sha256: fileSha }],
    });
    // Align digest with real projector so chunk reader recheck can use real reader OR mock.
    // Use mock snapshotReader for both store + chunk reader so descriptor/manifest match,
    // while real open hits missing leaf.
    const snapshotMock = makeAssertReadable(mockReadable);
    const taskStore = createRestoreTaskStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: snapshotMock,
      now: () => new Date(T0),
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000033',
    });
    const created = await taskStore.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;
    await taskStore.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });

    const reader = createRestoreChunkReader({
      dataDir: /** @type {string} */ (dataDir),
      taskStore,
      snapshotReader: snapshotMock,
      openSafeRootRelativeReadFn: openSafeRootRelativeRead,
    });

    await expectCode(
      () =>
        reader.readChunk({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [leafAbs, dataDir ?? '', 'gone.bin', 'ENOENT', 'secret-token'],
      },
    );
  });
});

// ── 5. constant export alignment (reader may re-export or not) ─────

describe('chunk size constant alignment', () => {
  it('RESTORE_CHUNK_SIZE_BYTES remains 8 MiB authority for geometry tests', () => {
    assert.equal(RESTORE_CHUNK_SIZE_BYTES, CHUNK);
    assert.equal(RESTORE_CHUNK_SIZE_BYTES, 8_388_608);
  });
});

// ── 6. GLM findings regression (expected RED until production hardens) ─

/**
 * Hostile Proxy: getPrototypeOf / get / ownKeys / getOwnPropertyDescriptor throw
 * raw Error carrying token + path (must never surface outside reader boundary).
 * `then` is intentionally undefined so Promise resolution delivers the proxy value
 * (otherwise await alone trips the get trap and masks post-resolve inspection paths).
 * @param {string} label
 * @param {object} [target]
 */
function makeHostileTrapProxy(label, target = {}) {
  const leakPath = `${dataDir ?? '/tmp'}/repo/devices/x/snapshots/y/files/hostile-${label}.bin`;
  const leakToken = `secret-token-${label}`;
  const throwRaw = () => {
    throw new Error(`PROXY_SENTINEL ${leakToken} path=${leakPath}`);
  };
  return {
    proxy: new Proxy(target, {
      getPrototypeOf: throwRaw,
      get(_target, prop) {
        // Allow non-thenable settlement so traps fire during reader inspection.
        if (prop === 'then') return undefined;
        throwRaw();
      },
      ownKeys: throwRaw,
      getOwnPropertyDescriptor: throwRaw,
      has: throwRaw,
    }),
    leakPath,
    leakToken,
  };
}

/**
 * Minimal matching descriptor + readable for GLM boundary tests.
 * @param {Buffer} content
 * @param {string} [path]
 */
function glmMatchingPair(content, path = 'glm.bin') {
  const fileSha = sha256Buf(content);
  const fileSize = content.length;
  const chunkCount = fileSize === 0 ? 0 : Math.ceil(fileSize / CHUNK);
  const desc = makeDescriptor({
    path,
    fileSize,
    fileSha256: fileSha,
    chunkCount,
    chunkIndex: 0,
    chunkOffset: 0,
    chunkSize: fileSize > CHUNK ? CHUNK : Math.max(fileSize, 1),
    manifestDigest: 'a'.repeat(64),
  });
  const readable = makeReadableResult({
    manifestDigest: desc.manifestDigest,
    files: [{ path, size: fileSize, sha256: fileSha }],
  });
  return { desc, readable };
}

describe('GLM: assertSnapshotReadable LinkeError always → RESTORE_INTEGRITY_FAILED', () => {
  const codes = [
    ERROR_CODES.RESTORE_TASK_INVALID,
    ERROR_CODES.RESTORE_TASK_NOT_FOUND,
    ERROR_CODES.RESTORE_TASK_CONFLICT,
    ERROR_CODES.RESTORE_PATH_INVALID,
    ERROR_CODES.RESTORE_STATE_INVALID,
  ];

  for (const code of codes) {
    it(`assertSnapshotReadable throws ${code} → integrity only; no open; no pass-through`, async () => {
      const content = Buffer.alloc(64, 0x7a);
      const { desc } = glmMatchingPair(content, 'asr-code.bin');
      const original = new LinkeError(code);
      const openFake = makeOpenFake({ content, size: content.length });
      const snapshotReader = {
        assertSnapshotReadable: async () => {
          throw original;
        },
      };
      const reader = openReader({
        taskStore: { resolveChunkRead: async () => desc },
        snapshotReader,
        openSafeRootRelativeReadFn: openFake.openFn,
      });

      await assert.rejects(
        () =>
          reader.readChunk({
            deviceId: desc.deviceId,
            taskId: desc.taskId,
            fileIndex: 0,
            chunkIndex: 0,
          }),
        (err) => {
          assertLinkeCode(err, ERROR_CODES.RESTORE_INTEGRITY_FAILED, {
            statusCode: 422,
            retryable: false,
            leakTokens: [desc.path, code, dataDir ?? ''],
          });
          assert.notEqual(
            err,
            original,
            'must not pass through snapshotReader LinkeError object',
          );
          assert.notEqual(err.code, code, 'must not surface snapshotReader task/path/state code');
          return true;
        },
      );
      assert.equal(openFake.openCalls.length, 0, 'must not open after assertSnapshotReadable fail');
      assert.equal(openFake.closeCount, 0);
    });
  }
});

describe('GLM: resolveChunkRead only TASK_INVALID/NOT_FOUND/CONFLICT exact pass-through', () => {
  it('TASK_INVALID / NOT_FOUND / CONFLICT rethrow exact same object; no open', async () => {
    const passThrough = [
      ERROR_CODES.RESTORE_TASK_INVALID,
      ERROR_CODES.RESTORE_TASK_NOT_FOUND,
      ERROR_CODES.RESTORE_TASK_CONFLICT,
    ];
    for (const code of passThrough) {
      const original = new LinkeError(code);
      const openFake = makeOpenFake();
      const snapshotReader = makeAssertReadable(
        makeReadableResult({
          files: [{ path: 'a.bin', size: 1, sha256: sha256Str('x') }],
        }),
      );
      const reader = openReader({
        taskStore: {
          resolveChunkRead: async () => {
            throw original;
          },
        },
        snapshotReader,
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await assert.rejects(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
            fileIndex: 0,
            chunkIndex: 0,
          }),
        (err) => {
          assert.equal(err, original, `${code}: must rethrow exact same LinkeError object`);
          return true;
        },
      );
      assert.equal(snapshotReader.callCount, 0, `${code}: no assert after resolve fail`);
      assert.equal(openFake.openCalls.length, 0, `${code}: no open after resolve fail`);
    }
  });

  it('PATH_INVALID / STATE_INVALID / other LinkeError from resolve → integrity; no open', async () => {
    const mapToIntegrity = [
      ERROR_CODES.RESTORE_PATH_INVALID,
      ERROR_CODES.RESTORE_STATE_INVALID,
      ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT,
      ERROR_CODES.RESTORE_BACKPRESSURE,
    ];
    for (const code of mapToIntegrity) {
      const original = new LinkeError(code);
      const openFake = makeOpenFake();
      const snapshotReader = makeAssertReadable(
        makeReadableResult({
          files: [{ path: 'a.bin', size: 1, sha256: sha256Str('x') }],
        }),
      );
      const reader = openReader({
        taskStore: {
          resolveChunkRead: async () => {
            throw original;
          },
        },
        snapshotReader,
        openSafeRootRelativeReadFn: openFake.openFn,
      });
      await assert.rejects(
        () =>
          reader.readChunk({
            deviceId: DEVICE_A,
            taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
            fileIndex: 0,
            chunkIndex: 0,
          }),
        (err) => {
          assertLinkeCode(err, ERROR_CODES.RESTORE_INTEGRITY_FAILED, {
            statusCode: 422,
            leakTokens: [code, dataDir ?? ''],
          });
          assert.notEqual(err, original, `${code}: must not pass through non-task-domain object`);
          assert.notEqual(err.code, code, `${code}: must map to integrity`);
          return true;
        },
      );
      assert.equal(snapshotReader.callCount, 0, `${code}: no assert after resolve fail`);
      assert.equal(openFake.openCalls.length, 0, `${code}: no open after resolve fail`);
    }
  });
});

describe('GLM: hostile Proxy on descriptor/readable/files/entry → integrity, no open, no leak', () => {
  it('hostile descriptor Proxy traps → RESTORE_INTEGRITY_FAILED; no open; no raw leak', async () => {
    const { proxy, leakPath, leakToken } = makeHostileTrapProxy('descriptor');
    const openFake = makeOpenFake();
    const snapshotReader = makeAssertReadable(
      makeReadableResult({
        files: [{ path: 'a.bin', size: 1, sha256: sha256Str('x') }],
      }),
    );
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => proxy },
      snapshotReader,
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    await expectCode(
      () =>
        reader.readChunk({
          deviceId: DEVICE_A,
          taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [leakPath, leakToken, 'PROXY_SENTINEL'],
      },
    );
    assert.equal(openFake.openCalls.length, 0);
    assert.equal(snapshotReader.callCount, 0, 'must fail before assert on hostile descriptor');
  });

  it('hostile readable Proxy traps → integrity; no open; no raw leak', async () => {
    const content = Buffer.alloc(32, 0x41);
    const { desc } = glmMatchingPair(content, 'readable-proxy.bin');
    const { proxy, leakPath, leakToken } = makeHostileTrapProxy('readable');
    const openFake = makeOpenFake({ content, size: content.length });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: {
        assertSnapshotReadable: async () => proxy,
      },
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    await expectCode(
      () =>
        reader.readChunk({
          deviceId: desc.deviceId,
          taskId: desc.taskId,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [leakPath, leakToken, 'PROXY_SENTINEL', desc.path],
      },
    );
    assert.equal(openFake.openCalls.length, 0);
  });

  it('hostile files Proxy traps → integrity; no open; no raw leak', async () => {
    const content = Buffer.alloc(32, 0x42);
    const { desc } = glmMatchingPair(content, 'files-proxy.bin');
    const { proxy: filesProxy, leakPath, leakToken } = makeHostileTrapProxy('files', []);
    // Plain readable shell; only files is hostile (Array.isArray may pass via array target).
    const readable = {
      manifestDigest: desc.manifestDigest,
      fileCount: 1,
      totalBytes: desc.fileSize,
      files: filesProxy,
    };
    const openFake = makeOpenFake({ content, size: content.length });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: { assertSnapshotReadable: async () => readable },
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    await expectCode(
      () =>
        reader.readChunk({
          deviceId: desc.deviceId,
          taskId: desc.taskId,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [leakPath, leakToken, 'PROXY_SENTINEL', desc.path],
      },
    );
    assert.equal(openFake.openCalls.length, 0);
  });

  it('hostile entry Proxy traps → integrity; no open; no raw leak', async () => {
    const content = Buffer.alloc(32, 0x43);
    const { desc } = glmMatchingPair(content, 'entry-proxy.bin');
    const { proxy: entryProxy, leakPath, leakToken } = makeHostileTrapProxy('entry');
    const readable = {
      manifestDigest: desc.manifestDigest,
      fileCount: 1,
      totalBytes: desc.fileSize,
      files: [entryProxy],
    };
    const openFake = makeOpenFake({ content, size: content.length });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: { assertSnapshotReadable: async () => readable },
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    await expectCode(
      () =>
        reader.readChunk({
          deviceId: desc.deviceId,
          taskId: desc.taskId,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [leakPath, leakToken, 'PROXY_SENTINEL', desc.path],
      },
    );
    assert.equal(openFake.openCalls.length, 0);
  });
});

describe('GLM: factory options/taskStore/snapshotReader hostile Proxy/getter → fixed TypeError', () => {
  it('options hostile Proxy traps → TypeError only; raw sentinel never surfaces', () => {
    const { proxy, leakToken } = makeHostileTrapProxy('options');
    assert.throws(
      () => createRestoreChunkReader(/** @type {any} */ (proxy)),
      (err) => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${err}`);
        const text = `${err?.name}\0${err?.message}\0${err?.code ?? ''}`;
        assert.ok(!text.includes('PROXY_SENTINEL'), 'must not leak PROXY_SENTINEL');
        assert.ok(!text.includes(leakToken), 'must not leak token');
        assert.ok(!(err instanceof LinkeError));
        return true;
      },
    );
  });

  it('taskStore hostile Proxy traps → TypeError; no raw sentinel', () => {
    const { proxy: hostileStore, leakToken } = makeHostileTrapProxy('taskStore');
    assert.throws(
      () =>
        createRestoreChunkReader({
          dataDir: /** @type {string} */ (dataDir),
          taskStore: /** @type {any} */ (hostileStore),
          snapshotReader: { assertSnapshotReadable: async () => ({}) },
        }),
      (err) => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${err}`);
        const text = `${err?.name}\0${err?.message}`;
        assert.ok(!text.includes('PROXY_SENTINEL'));
        assert.ok(!text.includes(leakToken));
        return true;
      },
    );
  });

  it('resolveChunkRead defined as getter → TypeError; getter never executes', () => {
    let getterRan = false;
    const taskStore = {};
    Object.defineProperty(taskStore, 'resolveChunkRead', {
      configurable: true,
      enumerable: true,
      get() {
        getterRan = true;
        return async () => makeDescriptor();
      },
    });
    assert.throws(
      () =>
        createRestoreChunkReader({
          dataDir: /** @type {string} */ (dataDir),
          taskStore,
          snapshotReader: {
            assertSnapshotReadable: async () =>
              makeReadableResult({
                files: [{ path: 'a.bin', size: 1, sha256: sha256Str('x') }],
              }),
          },
        }),
      TypeError,
    );
    assert.equal(getterRan, false, 'resolveChunkRead getter must not execute');
  });

  it('snapshotReader hostile Proxy traps → TypeError; no raw sentinel', () => {
    const { proxy: hostileReader, leakToken } = makeHostileTrapProxy('snapshotReader');
    assert.throws(
      () =>
        createRestoreChunkReader({
          dataDir: /** @type {string} */ (dataDir),
          taskStore: { resolveChunkRead: async () => makeDescriptor() },
          snapshotReader: /** @type {any} */ (hostileReader),
        }),
      (err) => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${err}`);
        const text = `${err?.name}\0${err?.message}`;
        assert.ok(!text.includes('PROXY_SENTINEL'));
        assert.ok(!text.includes(leakToken));
        return true;
      },
    );
  });

  it('assertSnapshotReadable defined as getter → TypeError; getter never executes', () => {
    let getterRan = false;
    const snapshotReader = {};
    Object.defineProperty(snapshotReader, 'assertSnapshotReadable', {
      configurable: true,
      enumerable: true,
      get() {
        getterRan = true;
        return async () =>
          makeReadableResult({
            files: [{ path: 'a.bin', size: 1, sha256: sha256Str('x') }],
          });
      },
    });
    assert.throws(
      () =>
        createRestoreChunkReader({
          dataDir: /** @type {string} */ (dataDir),
          taskStore: { resolveChunkRead: async () => makeDescriptor() },
          snapshotReader,
        }),
      TypeError,
    );
    assert.equal(getterRan, false, 'assertSnapshotReadable getter must not execute');
  });
});

describe('GLM: close reject must not leak EIO/path or mask primary error', () => {
  it('success path: close rejects with EIO/path → main result intact; no leak', async () => {
    const content = Buffer.alloc(128, 0x5a);
    const { desc, readable } = glmMatchingPair(content, 'close-ok.bin');
    const leakPath = `${dataDir}/repo/devices/x/snapshots/y/files/close-ok.bin`;
    const closeErr = Object.assign(new Error(`EIO: close failed '${leakPath}'`), {
      code: 'EIO',
      errno: -5,
      path: leakPath,
    });
    const openFake = makeOpenFake({
      content,
      size: content.length,
      closeError: closeErr,
    });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: makeAssertReadable(readable),
      openSafeRootRelativeReadFn: openFake.openFn,
    });

    const result = await reader.readChunk({
      deviceId: desc.deviceId,
      taskId: desc.taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.deepEqual(result.body, content);
    assert.equal(result.chunkOffset, 0);
    assert.equal(result.chunkSize, content.length);
    assert.equal(openFake.closeCount, 1);
    assert.equal(openFake.currentlyOpen, false);
    // Public success surface must not carry close failure artifacts
    const blob = JSON.stringify({
      chunkOffset: result.chunkOffset,
      chunkSize: result.chunkSize,
      keys: Object.keys(result),
    });
    assert.ok(!blob.includes('EIO'));
    assert.ok(!blob.includes(leakPath));
    assert.ok(!blob.includes(/** @type {string} */ (dataDir)));
    assertReadsWithinChunkWindow(openFake.readCalls, desc.chunkOffset, desc.chunkSize);
  });

  it('primary integrity error: close rejects → primary RESTORE_INTEGRITY_FAILED preserved', async () => {
    const content = Buffer.alloc(200, 0x5b);
    const { desc, readable } = glmMatchingPair(content, 'close-mask.bin');
    const leakPath = `${dataDir}/repo/devices/x/snapshots/y/files/close-mask.bin`;
    const closeErr = Object.assign(new Error(`EIO close path=${leakPath} secret-token-close`), {
      code: 'EIO',
      errno: -5,
      path: leakPath,
    });
    const openFake = makeOpenFake({
      content,
      size: content.length,
      readPlan: ['zero'], // early EOF → primary integrity
      closeError: closeErr,
    });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: makeAssertReadable(readable),
      openSafeRootRelativeReadFn: openFake.openFn,
    });

    await expectCode(
      () =>
        reader.readChunk({
          deviceId: desc.deviceId,
          taskId: desc.taskId,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [leakPath, 'EIO', 'secret-token-close', 'errno', desc.path, dataDir ?? ''],
      },
    );
    assert.equal(openFake.closeCount, 1, 'must still attempt close');
    assert.equal(openFake.currentlyOpen, false);
  });
});

describe('GLM: bounded read evidence (fake handle) + static no full-file hash', () => {
  it('fake handle records every read inside descriptor chunk window; cumulative == chunkSize', async () => {
    // Multi-short-read path still stays inside window.
    const content = Buffer.alloc(5000, 0x6c);
    const { desc, readable } = glmMatchingPair(content, 'window.bin');
    const openFake = makeOpenFake({
      content,
      size: content.length,
      readPlan: ['short', 'short', 'short', 'full'],
    });
    const reader = openReader({
      taskStore: { resolveChunkRead: async () => desc },
      snapshotReader: makeAssertReadable(readable),
      openSafeRootRelativeReadFn: openFake.openFn,
    });
    const res = await reader.readChunk({
      deviceId: desc.deviceId,
      taskId: desc.taskId,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.equal(res.body.length, content.length);
    assert.deepEqual(res.body, content);
    assertReadsWithinChunkWindow(openFake.readCalls, desc.chunkOffset, desc.chunkSize);
    assert.ok(openFake.readCalls.length >= 2, 'short-read plan must produce multiple reads');
  });

  it('static: restore-chunk-reader.js must not import/reference full-file hash APIs', async () => {
    const readerSrc = await readFile(
      new URL('../src/restore-chunk-reader.js', import.meta.url),
      'utf8',
    );
    assert.ok(!readerSrc.includes('safeHashFileSha256'));
    assert.ok(!readerSrc.includes('safeHashFileSha256Fn'));
    assert.ok(!/\bcreateReadStream\b/.test(readerSrc));
    assert.ok(
      !/from\s+['"]node:crypto['"]/.test(readerSrc),
      'chunk reader must not pull crypto for full-file hashing',
    );
  });
});
