/**
 * C3 RED — Bounded Chunk Ingest + Resume Idempotency.
 * Targets public API of src/upload-chunk-ingest.js (not yet implemented).
 * Authority: design §6.0–§6.3 + plan C3. Error codes are exact (no alternates).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { UPLOAD_CHUNK_SIZE } from '../src/upload-session-store.js';
import {
  parseChunkHeaders,
  assertContiguousOrder,
  ingestChunkBody,
  commitChunk,
} from '../src/upload-chunk-ingest.js';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const UPLOAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const UPLOAD_ID_OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440000';
const SNAPSHOT_ID_OTHER = '550e8400-e29b-41d4-a716-446655440001';
const MANIFEST_DIGEST = 'b'.repeat(64);
const MANIFEST_DIGEST_OTHER = 'c'.repeat(64);
const CHUNK_SHA_A = 'd'.repeat(64);
const CHUNK_SHA_B = 'e'.repeat(64);
const TOKEN = 'test-device-token-not-a-secret-fixture';

const CHUNK_HEADER_NAMES = Object.freeze([
  'content-length',
  'x-linke-upload-id',
  'x-linke-snapshot-id',
  'x-linke-manifest-digest',
  'x-linke-file-index',
  'x-linke-chunk-index',
  'x-linke-chunk-offset',
  'x-linke-chunk-size',
  'x-linke-chunk-sha256',
]);

const AUTH_HEADER_NAMES = Object.freeze([
  'authorization',
  'x-linke-device-id',
  'x-linke-protocol-version',
]);

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
  // Own public fields only — never require stack inspection (paths live there).
  const ownText = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    error.details ? JSON.stringify(error.details) : '',
  ].join('\0');
  for (const token of opts.leakTokens ?? []) {
    if (!token || token.length < 2) continue;
    assert.ok(!ownText.includes(token), `must not leak ${token}`);
  }
}

/**
 * Build Node-style rawHeaders flat list from pairs. Supports duplicates.
 * @param {Array<[string, string]>} pairs
 */
function rawFromPairs(pairs) {
  /** @type {string[]} */
  const raw = [];
  for (const [k, v] of pairs) {
    raw.push(k, v);
  }
  return raw;
}

/**
 * @param {Partial<{
 *   authorization: string,
 *   deviceId: string,
 *   protocolVersion: string,
 *   contentLength: string,
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   fileIndex: string,
 *   chunkIndex: string,
 *   offset: string,
 *   size: string,
 *   sha256: string,
 *   extra: Array<[string, string]>,
 *   omit: string[],
 * }>} [opts]
 */
function validHeaderPairs(opts = {}) {
  const omit = new Set(opts.omit ?? []);
  /** @type {Array<[string, string]>} */
  const pairs = [];
  const push = (name, value) => {
    if (!omit.has(name.toLowerCase())) pairs.push([name, value]);
  };
  push('Authorization', opts.authorization ?? `Bearer ${TOKEN}`);
  push('X-Linke-Device-Id', opts.deviceId ?? DEVICE_A);
  push('X-Linke-Protocol-Version', opts.protocolVersion ?? '2');
  push('Content-Length', opts.contentLength ?? '10');
  push('X-Linke-Upload-Id', opts.uploadId ?? UPLOAD_ID);
  push('X-Linke-Snapshot-Id', opts.snapshotId ?? SNAPSHOT_ID);
  push('X-Linke-Manifest-Digest', opts.manifestDigest ?? MANIFEST_DIGEST);
  push('X-Linke-File-Index', opts.fileIndex ?? '0');
  push('X-Linke-Chunk-Index', opts.chunkIndex ?? '0');
  push('X-Linke-Chunk-Offset', opts.offset ?? '0');
  push('X-Linke-Chunk-Size', opts.size ?? '10');
  push('X-Linke-Chunk-Sha256', opts.sha256 ?? CHUNK_SHA_A);
  for (const pair of opts.extra ?? []) pairs.push(pair);
  return pairs;
}

/**
 * @param {ReturnType<typeof validHeaderPairs>} pairs
 */
function makeReq(pairs, { url = `/agent/upload/sessions/${UPLOAD_ID}/chunks` } = {}) {
  const rawHeaders = rawFromPairs(pairs);
  /** @type {Record<string, string | string[] | undefined>} */
  const headers = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase();
    const value = rawHeaders[i + 1];
    if (headers[key] === undefined) headers[key] = value;
    else if (Array.isArray(headers[key])) /** @type {string[]} */ (headers[key]).push(value);
    else headers[key] = [/** @type {string} */ (headers[key]), value];
  }
  return {
    rawHeaders,
    headers,
    url,
    method: 'POST',
  };
}

/**
 * Mock readable that records consumption for preflight/body discipline.
 * @param {Buffer | string | Buffer[]} payload
 * @param {{ pauseOnConstruct?: boolean }} [opts]
 */
function makeBodyStream(payload, opts = {}) {
  const chunks = Array.isArray(payload)
    ? payload.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))
    : [Buffer.isBuffer(payload) ? payload : Buffer.from(payload)];
  let bytesRead = 0;
  let destroyCount = 0;
  let endEmitted = false;
  /** @type {string[]} */
  const events = [];

  const stream = new Readable({
    read() {
      // no-op; we push externally or via pushAll
    },
  });

  const originalDestroy = stream.destroy.bind(stream);
  stream.destroy = (err) => {
    destroyCount += 1;
    events.push('destroy');
    return originalDestroy(err);
  };

  stream.on('data', (buf) => {
    bytesRead += buf.length;
    events.push(`data:${buf.length}`);
  });
  stream.on('end', () => {
    endEmitted = true;
    events.push('end');
  });

  if (opts.pauseOnConstruct) stream.pause();

  return {
    stream,
    get bytesRead() {
      return bytesRead;
    },
    get destroyCount() {
      return destroyCount;
    },
    get endEmitted() {
      return endEmitted;
    },
    get events() {
      return events.slice();
    },
    /** Push all payload and end (async-friendly). */
    pushAll() {
      for (const c of chunks) stream.push(c);
      stream.push(null);
    },
    /** Oversize: push more than expected. */
    pushBytes(n, fill = 0x61) {
      stream.push(Buffer.alloc(n, fill));
    },
    end() {
      stream.push(null);
    },
  };
}

/**
 * Session-shaped object for order/identity checks (public summary shape).
 * @param {Partial<{
 *   uploadId: string,
 *   deviceId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   status: string,
 *   files: Array<{
 *     fileIndex: number,
 *     size: number,
 *     confirmedBytes: number,
 *     confirmedChunks: number,
 *     complete: boolean,
 *   }>,
 * }>} [overrides]
 */
function makeSession(overrides = {}) {
  return {
    uploadId: overrides.uploadId ?? UPLOAD_ID,
    deviceId: overrides.deviceId ?? DEVICE_A,
    snapshotId: overrides.snapshotId ?? SNAPSHOT_ID,
    manifestDigest: overrides.manifestDigest ?? MANIFEST_DIGEST,
    status: overrides.status ?? 'receiving',
    createdAt: '2026-07-22T12:00:00.000Z',
    expiresAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    files: overrides.files ?? [
      {
        fileIndex: 0,
        size: 10,
        confirmedBytes: 0,
        confirmedChunks: 0,
        complete: false,
      },
    ],
  };
}

/**
 * @param {Partial<{
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   deviceId: string,
 *   fileIndex: number,
 *   chunkIndex: number,
 *   offset: number,
 *   size: number,
 *   sha256: string,
 * }>} [overrides]
 */
function makeIdentity(overrides = {}) {
  return {
    uploadId: overrides.uploadId ?? UPLOAD_ID,
    snapshotId: overrides.snapshotId ?? SNAPSHOT_ID,
    manifestDigest: overrides.manifestDigest ?? MANIFEST_DIGEST,
    deviceId: overrides.deviceId ?? DEVICE_A,
    fileIndex: overrides.fileIndex ?? 0,
    chunkIndex: overrides.chunkIndex ?? 0,
    offset: overrides.offset ?? 0,
    size: overrides.size ?? 10,
    sha256: overrides.sha256 ?? CHUNK_SHA_A,
  };
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Minimal fake store recording advance/abort order for commitChunk tests.
 */
function makeFakeStore(session) {
  /** @type {Array<{ op: string, args: unknown }>} */
  const calls = [];
  let current = structuredClone(session);
  return {
    calls,
    get session() {
      return structuredClone(current);
    },
    async advanceBoundary(input) {
      calls.push({ op: 'advanceBoundary', args: input });
      const file = current.files.find((f) => f.fileIndex === input.fileIndex);
      if (!file) throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
      file.confirmedBytes += input.chunkBytes;
      file.confirmedChunks += 1;
      if (file.confirmedBytes === file.size) file.complete = true;
      if (current.status === 'initialized') current.status = 'receiving';
      current.updatedAt = '2026-07-22T12:01:00.000Z';
      return structuredClone(current);
    },
    async abortSession(input) {
      calls.push({ op: 'abortSession', args: input });
      current.status = 'aborted';
      return structuredClone(current);
    },
    async getSession() {
      return structuredClone(current);
    },
  };
}

// ── parseChunkHeaders: preflight / exact-one / syntax ───────────────

describe('parseChunkHeaders preflight (exact-one critical + auth)', () => {
  it('header-only: bare rawHeaders array validates headers (no URL contract)', () => {
    // C3 pure helper: array input can only see headers. URL/uploadId wire match is
    // C6 responsibility via req-shaped { rawHeaders, url }. Do not stuff URL into array.
    const pairs = validHeaderPairs({
      size: '10',
      contentLength: '10',
    });
    // Mix casing on critical names
    pairs[pairs.findIndex((p) => p[0].toLowerCase() === 'x-linke-chunk-size')] = [
      'x-LiNkE-cHuNk-SiZe',
      '10',
    ];
    pairs[pairs.findIndex((p) => p[0].toLowerCase() === 'content-length')] = [
      'content-length',
      '10',
    ];
    const identity = parseChunkHeaders(rawFromPairs(pairs));
    assert.equal(identity.uploadId, UPLOAD_ID);
    assert.equal(identity.snapshotId, SNAPSHOT_ID);
    assert.equal(identity.manifestDigest, MANIFEST_DIGEST);
    assert.equal(identity.fileIndex, 0);
    assert.equal(identity.chunkIndex, 0);
    assert.equal(identity.offset, 0);
    assert.equal(identity.size, 10);
    assert.equal(identity.sha256, CHUNK_SHA_A);
    assert.equal(identity.deviceId, DEVICE_A);
  });

  it('req object with rawHeaders (matching URL) returns ChunkIdentity', () => {
    const req = makeReq(validHeaderPairs());
    const identity = parseChunkHeaders(req);
    assert.equal(identity.uploadId, UPLOAD_ID);
    assert.equal(identity.size, 10);
  });

  for (const name of [...AUTH_HEADER_NAMES, ...CHUNK_HEADER_NAMES]) {
    it(`missing ${name} → upload-chunk-invalid before body`, () => {
      const pairs = validHeaderPairs({ omit: [name] });
      const body = makeBodyStream(Buffer.alloc(10, 0x61));
      // makeBodyStream itself installs a data listener for bytesRead accounting;
      // baseline before parse so we assert "no new consumers", not absolute zero.
      const dataListenersBefore = body.stream.listenerCount('data');
      const endListenersBefore = body.stream.listenerCount('end');
      const errorListenersBefore = body.stream.listenerCount('error');
      assert.throws(
        () => parseChunkHeaders(rawFromPairs(pairs)),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
            statusCode: 400,
            retryable: false,
          });
          return true;
        },
      );
      // parseChunkHeaders is header-only; body stream must remain untouched.
      assert.equal(body.bytesRead, 0, 'preflight must not consume body');
      assert.equal(
        body.stream.listenerCount('data'),
        dataListenersBefore,
        'preflight must not add data listeners',
      );
      assert.equal(
        body.stream.listenerCount('end'),
        endListenersBefore,
        'preflight must not add end listeners',
      );
      assert.equal(
        body.stream.listenerCount('error'),
        errorListenersBefore,
        'preflight must not add error listeners',
      );
    });

    it(`duplicate ${name} (any case) → upload-chunk-invalid`, () => {
      const base = validHeaderPairs();
      const lower = name.toLowerCase();
      const original = base.find((p) => p[0].toLowerCase() === lower);
      assert.ok(original);
      // Second line with different casing still counts as duplicate exact-one violation.
      base.push([original[0].toUpperCase(), original[1]]);
      assert.throws(
        () => parseChunkHeaders(rawFromPairs(base)),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
          return true;
        },
      );
    });
  }

  it('Content-Length and X-Linke-Chunk-Size must be equal strict decimal positives in 1..8MiB', () => {
    const badSizes = [
      { contentLength: '0', size: '0' },
      { contentLength: '10', size: '11' },
      { contentLength: '11', size: '10' },
      { contentLength: '-1', size: '-1' },
      { contentLength: '01', size: '01' },
      { contentLength: '+10', size: '+10' },
      { contentLength: '10.0', size: '10.0' },
      { contentLength: '1e2', size: '1e2' },
      { contentLength: '10 ', size: '10 ' },
      { contentLength: ' 10', size: ' 10' },
      { contentLength: '0x10', size: '0x10' },
      { contentLength: String(UPLOAD_CHUNK_SIZE + 1), size: String(UPLOAD_CHUNK_SIZE + 1) },
      { contentLength: 'abc', size: 'abc' },
      { contentLength: '', size: '' },
    ];
    for (const bad of badSizes) {
      assert.throws(
        () => parseChunkHeaders(rawFromPairs(validHeaderPairs(bad))),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
          return true;
        },
        `expected invalid for CL=${bad.contentLength} size=${bad.size}`,
      );
    }
    // Exact max 8 MiB is legal
    const maxOk = parseChunkHeaders(
      rawFromPairs(
        validHeaderPairs({
          contentLength: String(UPLOAD_CHUNK_SIZE),
          size: String(UPLOAD_CHUNK_SIZE),
        }),
      ),
    );
    assert.equal(maxOk.size, UPLOAD_CHUNK_SIZE);
  });

  it('rejects size=0 chunk (zero-byte files must not send chunks)', () => {
    assert.throws(
      () =>
        parseChunkHeaders(
          rawFromPairs(validHeaderPairs({ contentLength: '0', size: '0' })),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
  });

  it('uploadId / snapshotId must be UUID-shaped lower hex; rejects uppercase and garbage', () => {
    for (const bad of [
      { uploadId: 'NOT-A-UUID' },
      { uploadId: UPLOAD_ID.toUpperCase() },
      { uploadId: 'gggggggg-bbbb-4ccc-8ddd-000000000001' },
      { snapshotId: 'x' },
      { snapshotId: SNAPSHOT_ID.toUpperCase() },
    ]) {
      assert.throws(
        () => parseChunkHeaders(rawFromPairs(validHeaderPairs(bad))),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
          return true;
        },
      );
    }
  });

  it('manifestDigest and chunk sha256 must be exactly 64 lower hex', () => {
    for (const bad of [
      { manifestDigest: 'A'.repeat(64) },
      { manifestDigest: 'b'.repeat(63) },
      { manifestDigest: 'b'.repeat(65) },
      { manifestDigest: 'g'.repeat(64) },
      { sha256: 'D'.repeat(64) },
      { sha256: 'd'.repeat(63) },
      { sha256: 'd'.repeat(65) },
      { sha256: 'zzzz' + 'd'.repeat(60) },
    ]) {
      assert.throws(
        () => parseChunkHeaders(rawFromPairs(validHeaderPairs(bad))),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
            statusCode: 400,
            leakTokens: Object.values(bad),
          });
          return true;
        },
      );
    }
  });

  it('fileIndex / chunkIndex / offset must be strict non-negative decimal integers', () => {
    for (const bad of [
      { fileIndex: '-1' },
      { fileIndex: '01' },
      { fileIndex: '1.5' },
      { fileIndex: '+0' },
      { chunkIndex: '-1' },
      { chunkIndex: '01' },
      { chunkIndex: '1e0' },
      { offset: '-1' },
      { offset: '01' },
      { offset: ' ' },
      { offset: '0x0' },
    ]) {
      assert.throws(
        () => parseChunkHeaders(rawFromPairs(validHeaderPairs(bad))),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
          return true;
        },
      );
    }
    // 0 is legal for indices/offset
    const id = parseChunkHeaders(
      rawFromPairs(
        validHeaderPairs({ fileIndex: '0', chunkIndex: '0', offset: '0' }),
      ),
    );
    assert.equal(id.fileIndex, 0);
    assert.equal(id.chunkIndex, 0);
    assert.equal(id.offset, 0);
  });

  it('req+url: URL uploadId vs header uploadId mismatch → upload-chunk-invalid (no body read)', () => {
    // C6 public routes must pass { rawHeaders, url }; bare array cannot check URL.
    const body = makeBodyStream(Buffer.alloc(10, 0x61));
    const req = makeReq(validHeaderPairs({ uploadId: UPLOAD_ID }));
    req.url = `/agent/upload/sessions/${UPLOAD_ID_OTHER}/chunks`;
    Object.assign(req, {
      on: body.stream.on.bind(body.stream),
      once: body.stream.once.bind(body.stream),
      read: body.stream.read.bind(body.stream),
      pipe: body.stream.pipe.bind(body.stream),
      resume: body.stream.resume.bind(body.stream),
      pause: body.stream.pause.bind(body.stream),
      destroy: body.stream.destroy.bind(body.stream),
    });
    assert.throws(
      () => parseChunkHeaders(req),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
          statusCode: 400,
          leakTokens: [UPLOAD_ID_OTHER, '/agent/upload'],
        });
        return true;
      },
    );
    assert.equal(body.bytesRead, 0);
    // Contrast: same headers as bare array still succeed (header-only, no URL).
    const headerOnly = parseChunkHeaders(rawFromPairs(validHeaderPairs({ uploadId: UPLOAD_ID })));
    assert.equal(headerOnly.uploadId, UPLOAD_ID);
  });

  it('preflight failure does not fully buffer body (stream remains unread)', () => {
    const body = makeBodyStream(Buffer.alloc(100, 0x62));
    const pairs = validHeaderPairs({ omit: ['x-linke-chunk-sha256'] });
    const req = makeReq(pairs);
    // Body available but parse must not consume it.
    const listenersBefore = body.stream.listenerCount('data');
    assert.throws(() => parseChunkHeaders(req), (error) => {
      assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
      return true;
    });
    assert.equal(body.bytesRead, 0);
    assert.equal(body.stream.listenerCount('data'), listenersBefore);
  });
});

// ── Identity: URL / header / session / device scope ─────────────────

describe('chunk identity vs session / authenticated device', () => {
  it('header snapshotId ≠ session → upload-chunk-invalid + abort; boundary unchanged', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    const identity = makeIdentity({ snapshotId: SNAPSHOT_ID_OTHER });
    const boundaryBefore = session.files[0].confirmedBytes;

    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity,
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            throw new Error('tempPublish must not run on identity mismatch');
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
          statusCode: 400,
          leakTokens: [SNAPSHOT_ID_OTHER, '/repo/', TOKEN],
        });
        return true;
      },
    );
    assert.ok(
      store.calls.some((c) => c.op === 'abortSession'),
      'must abort session on identity mismatch',
    );
    assert.ok(
      !store.calls.some((c) => c.op === 'advanceBoundary'),
      'must not advance boundary',
    );
    assert.equal(store.session.files[0].confirmedBytes, boundaryBefore);
    assert.equal(store.session.status, 'aborted');
  });

  it('header manifestDigest ≠ session → upload-chunk-invalid + abort', async () => {
    const session = makeSession();
    const store = makeFakeStore(session);
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ manifestDigest: MANIFEST_DIGEST_OTHER }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => ({ path: 'must-not-leak' }),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
          statusCode: 400,
          leakTokens: [MANIFEST_DIGEST_OTHER, 'must-not-leak'],
        });
        return true;
      },
    );
    assert.ok(store.calls.some((c) => c.op === 'abortSession'));
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
  });

  it('header uploadId ≠ session uploadId → upload-chunk-invalid + abort', async () => {
    const session = makeSession();
    const store = makeFakeStore(session);
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ uploadId: UPLOAD_ID_OTHER }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {},
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.ok(store.calls.some((c) => c.op === 'abortSession'));
  });

  it('authenticated device scope ≠ session deviceId → upload-chunk-invalid + abort', async () => {
    const session = makeSession({ deviceId: DEVICE_A });
    const store = makeFakeStore(session);
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ deviceId: DEVICE_B }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {},
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
          statusCode: 400,
          leakTokens: [DEVICE_B],
        });
        return true;
      },
    );
    assert.ok(store.calls.some((c) => c.op === 'abortSession'));
    assert.equal(store.session.files[0].confirmedBytes, 0);
  });
});

// ── assertContiguousOrder: resume / size / duplicate / future ───────

describe('assertContiguousOrder contiguous resume rules', () => {
  it('zero-byte file rejects any chunk with upload-chunk-invalid', () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 0, confirmedBytes: 0, confirmedChunks: 0, complete: true }],
    });
    assert.throws(
      () => assertContiguousOrder(session, makeIdentity({ size: 1, offset: 0, chunkIndex: 0 })),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
  });

  it('non-final chunk must be exact 8 MiB; smaller → upload-chunk-invalid', () => {
    const size = UPLOAD_CHUNK_SIZE + 100;
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size,
          confirmedBytes: 0,
          confirmedChunks: 0,
          complete: false,
        },
      ],
    });
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            size: UPLOAD_CHUNK_SIZE - 1,
            offset: 0,
            chunkIndex: 0,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
  });

  it('final chunk may be 1..8 MiB inclusive; exact expected is accepted', () => {
    const size = UPLOAD_CHUNK_SIZE + 5;
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size,
          confirmedBytes: UPLOAD_CHUNK_SIZE,
          confirmedChunks: 1,
          complete: false,
        },
      ],
    });
    const decision = assertContiguousOrder(
      session,
      makeIdentity({
        size: 5,
        offset: UPLOAD_CHUNK_SIZE,
        chunkIndex: 1,
      }),
    );
    assert.equal(decision.kind, 'expected');
  });

  it('exact expected next at confirmed boundary is accepted', () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const decision = assertContiguousOrder(
      session,
      makeIdentity({ size: 10, offset: 0, chunkIndex: 0 }),
    );
    assert.equal(decision.kind, 'expected');
  });

  it('exact duplicate same coordinates/size → kind duplicate (no throw)', () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 10, confirmedChunks: 1, complete: true }],
    });
    const decision = assertContiguousOrder(
      session,
      makeIdentity({ size: 10, offset: 0, chunkIndex: 0, sha256: CHUNK_SHA_A }),
    );
    assert.equal(decision.kind, 'duplicate');
  });

  it('future chunkIndex / gap → upload-chunk-out-of-order only; no abort signal', () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: UPLOAD_CHUNK_SIZE * 3, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            size: UPLOAD_CHUNK_SIZE,
            offset: UPLOAD_CHUNK_SIZE,
            chunkIndex: 1,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );
  });

  it('offset ≠ confirmed boundary → upload-chunk-out-of-order', () => {
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size: UPLOAD_CHUNK_SIZE * 2,
          confirmedBytes: UPLOAD_CHUNK_SIZE,
          confirmedChunks: 1,
          complete: false,
        },
      ],
    });
    // Claims chunkIndex 1 but wrong offset
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            size: UPLOAD_CHUNK_SIZE,
            offset: 0,
            chunkIndex: 1,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );
  });

  it('confirmed coordinate with conflicting size → upload-integrity-failed', () => {
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size: UPLOAD_CHUNK_SIZE * 2 + 7,
          confirmedBytes: UPLOAD_CHUNK_SIZE * 2,
          confirmedChunks: 2,
          complete: false,
        },
      ],
    });
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            size: UPLOAD_CHUNK_SIZE - 1,
            offset: 0,
            chunkIndex: 0,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
        });
        return true;
      },
    );
  });

  it('out-of-order does not mutate session object (boundary frozen)', () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 100, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const before = JSON.stringify(session);
    assert.throws(() =>
      assertContiguousOrder(
        session,
        makeIdentity({ size: 10, offset: 50, chunkIndex: 5 }),
      ),
    );
    assert.equal(JSON.stringify(session), before);
  });
});

// ── ingestChunkBody: bounded single-settle ──────────────────────────

describe('ingestChunkBody bounded single-settle reader', () => {
  it('reads exact expectedSize and resolves once with buffer', async () => {
    const payload = Buffer.alloc(16, 0x61);
    const body = makeBodyStream(payload);
    queueMicrotask(() => body.pushAll());
    const result = await ingestChunkBody(body.stream, {
      maxBytes: UPLOAD_CHUNK_SIZE,
      expectedSize: 16,
    });
    const buf = Buffer.isBuffer(result) ? result : result.body;
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 16);
    assert.ok(buf.equals(payload));
  });

  it('under-size (declared expected, early EOF) fail-closes without double settle', async () => {
    const body = makeBodyStream(Buffer.alloc(4, 0x61));
    queueMicrotask(() => body.pushAll());
    let settles = 0;
    await assert.rejects(
      async () => {
        try {
          await ingestChunkBody(body.stream, {
            maxBytes: UPLOAD_CHUNK_SIZE,
            expectedSize: 16,
          });
          settles += 1;
        } catch (error) {
          settles += 1;
          throw error;
        }
      },
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.equal(settles, 1);
  });

  it('over-size calls onOversize exactly once, destroys stream, single reject', async () => {
    let oversizeCalls = 0;
    const body = makeBodyStream([]);
    const expectedSize = 8;
    queueMicrotask(() => {
      body.pushBytes(20, 0x62);
      body.end();
    });
    let settles = 0;
    await assert.rejects(
      async () => {
        try {
          await ingestChunkBody(body.stream, {
            maxBytes: UPLOAD_CHUNK_SIZE,
            expectedSize,
            onOversize: () => {
              oversizeCalls += 1;
            },
          });
          settles += 1;
        } catch (error) {
          settles += 1;
          throw error;
        }
      },
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
          statusCode: 400,
          leakTokens: ['/tmp/', TOKEN, 'ECONNRESET'],
        });
        return true;
      },
    );
    assert.equal(oversizeCalls, 1, 'onOversize exactly once');
    assert.equal(settles, 1, 'single settle');
    assert.ok(body.destroyCount >= 1 || body.stream.destroyed, 'must destroy/drain on oversize');
  });

  it('hard ceiling: bytes beyond maxBytes (≤8MiB) trigger onOversize once then reject', async () => {
    let oversizeCalls = 0;
    const body = makeBodyStream([]);
    // Keep heap small: maxBytes parameter is the hard bound under test; parse layer
    // already rejects declared size > UPLOAD_CHUNK_SIZE.
    const maxBytes = 64;
    assert.ok(maxBytes <= UPLOAD_CHUNK_SIZE);
    queueMicrotask(() => {
      body.pushBytes(40);
      body.pushBytes(40);
      body.end();
    });
    await assert.rejects(
      () =>
        ingestChunkBody(body.stream, {
          maxBytes,
          expectedSize: 32,
          onOversize: () => {
            oversizeCalls += 1;
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.equal(oversizeCalls, 1);
  });

  it('declared size vs actual mismatch still single-settle fail-close', async () => {
    const body = makeBodyStream(Buffer.alloc(12, 0x63));
    queueMicrotask(() => body.pushAll());
    let settles = 0;
    await assert.rejects(
      async () => {
        try {
          await ingestChunkBody(body.stream, {
            maxBytes: UPLOAD_CHUNK_SIZE,
            expectedSize: 8,
            onOversize: () => {},
          });
          settles += 1;
        } catch (error) {
          settles += 1;
          throw error;
        }
      },
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.equal(settles, 1);
  });

  it('late data after settle does not second-resolve or throw unhandled', async () => {
    const stream = new Readable({ read() {} });
    const expectedSize = 4;
    const settlePromise = ingestChunkBody(stream, {
      maxBytes: UPLOAD_CHUNK_SIZE,
      expectedSize,
    });
    stream.push(Buffer.alloc(4, 0x64));
    stream.push(null);
    const first = await settlePromise;
    const buf = Buffer.isBuffer(first) ? first : first.body;
    assert.equal(buf.length, 4);
    // Late events after settle must be ignored (no throw to process)
    assert.doesNotThrow(() => {
      stream.emit('data', Buffer.alloc(1, 0x65));
      stream.emit('error', new Error('late-raw-error-must-not-leak'));
    });
  });
});

// ── commitChunk: publish → rehash → atomic advance; idempotent ACK ─

describe('commitChunk order, idempotency, integrity, redaction', () => {
  it('success: tempPublish then store.advanceBoundary; returns ACK summary', async () => {
    const session = makeSession({
      status: 'initialized',
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    /** @type {string[]} */
    const order = [];
    const identity = makeIdentity({ size: 10, sha256: CHUNK_SHA_A });
    const result = await commitChunk({
      store: {
        async advanceBoundary(input) {
          order.push('advance');
          return store.advanceBoundary(input);
        },
        async abortSession(input) {
          order.push('abort');
          return store.abortSession(input);
        },
      },
      session,
      identity,
      bodyHash: CHUNK_SHA_A,
      tempPublish: async (context) => {
        order.push('publish');
        // Frozen C3 contract: expected new chunk uses publish-new (not verify-existing).
        assert.equal(context?.mode, 'publish-new');
        return { ok: true };
      },
    });
    assert.deepEqual(order, ['publish', 'advance']);
    assert.ok(result);
    assert.equal(result.files[0].confirmedBytes, 10);
    assert.ok(!order.includes('abort'));
  });

  it('exact duplicate: idempotent ACK without rewrite / without crossing boundary', async () => {
    const session = makeSession({
      status: 'receiving',
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 10, confirmedChunks: 1, complete: true }],
    });
    const store = makeFakeStore(session);
    let publishCalls = 0;
    let advanceCalls = 0;
    /** @type {unknown[]} */
    const modes = [];
    const confirmedBefore = session.files[0].confirmedBytes;
    const chunksBefore = session.files[0].confirmedChunks;
    const result = await commitChunk({
      store: {
        async advanceBoundary(input) {
          advanceCalls += 1;
          // Store-level duplicate: return same summary without mutation
          store.calls.push({ op: 'advanceBoundary', args: input });
          return store.session;
        },
        async abortSession(input) {
          return store.abortSession(input);
        },
        getSession: () => store.getSession(),
      },
      session,
      identity: makeIdentity({ size: 10, offset: 0, chunkIndex: 0, sha256: CHUNK_SHA_A }),
      bodyHash: CHUNK_SHA_A,
      // C2 summary has no per-chunk hash; duplicate path must verify existing staging
      // content via exclusive/verify-only dependency to distinguish §6.3 rule 3 (exact
      // duplicate ACK) from rule 5 (same coords, conflicting hash → integrity+abort).
      // Returning existingSha256 is a verify-only existing-content check, not a rewrite.
      tempPublish: async (context) => {
        publishCalls += 1;
        modes.push(context?.mode);
        // Frozen: duplicate must pass mode=verify-existing (read-only rehash), never rewrite.
        assert.equal(context?.mode, 'verify-existing');
        return { existingSha256: CHUNK_SHA_A };
      },
    });
    assert.equal(result.files[0].confirmedBytes, confirmedBefore);
    assert.equal(result.files[0].confirmedChunks, chunksBefore);
    assert.equal(result.files[0].complete, true);
    // Exactly one verify-only existing-content check; never rewrite / re-publish.
    assert.equal(publishCalls, 1, 'duplicate must verify existing staging exactly once');
    assert.deepEqual(modes, ['verify-existing']);
    // Must not double-count advance; boundary must not grow past already-confirmed.
    assert.ok(advanceCalls <= 1, 'must not double-advance');
    assert.equal(store.session.files[0].confirmedBytes, confirmedBefore);
    assert.equal(store.session.files[0].confirmedChunks, chunksBefore);
  });

  it('future/out-of-order at commit: upload-chunk-out-of-order; no abort; no advance', async () => {
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size: UPLOAD_CHUNK_SIZE * 2,
          confirmedBytes: 0,
          confirmedChunks: 0,
          complete: false,
        },
      ],
    });
    const store = makeFakeStore(session);
    let published = false;
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({
            size: UPLOAD_CHUNK_SIZE,
            offset: UPLOAD_CHUNK_SIZE,
            chunkIndex: 1,
            sha256: CHUNK_SHA_A,
          }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            published = true;
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(published, false);
    assert.ok(!store.calls.some((c) => c.op === 'abortSession'));
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
    assert.equal(store.session.files[0].confirmedBytes, 0);
  });

  it('confirmed coordinate hash conflict → upload-integrity-failed + abort; no advance', async () => {
    // Design §6.3 rule 5: same confirmed coordinates but hash differs from
    // previously confirmed/staging material → unique integrity failure + abort.
    // Implementation recovers prior hash from staging (via tempPublish/rehash),
    // not from an extra undocumented option bag field.
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 10, confirmedChunks: 1, complete: true }],
    });
    const store = makeFakeStore(session);
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({
            size: 10,
            offset: 0,
            chunkIndex: 0,
            sha256: CHUNK_SHA_B,
          }),
          bodyHash: CHUNK_SHA_B,
          tempPublish: async () => ({
            // Existing confirmed staging content hash (A) ≠ claimed B
            existingSha256: CHUNK_SHA_A,
          }),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
          leakTokens: [CHUNK_SHA_A, CHUNK_SHA_B, '/staging/', 'secret'],
        });
        return true;
      },
    );
    assert.ok(store.calls.some((c) => c.op === 'abortSession'));
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
    assert.equal(store.session.files[0].confirmedBytes, 10);
  });

  it('bodyHash ≠ identity.sha256 → upload-integrity-failed; no false ACK; no advance', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_B,
          tempPublish: async () => ({ ok: true }),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
        });
        return true;
      },
    );
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
  });

  it('tempPublish failure: no advance, no false ACK, unique upload-io-error, no path/raw leak', async () => {
    const session = makeSession();
    const store = makeFakeStore(session);
    const secretPath = '/Users/private/staging/chunk-0.part';
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            const err = new Error(`ENOSPC at ${secretPath}`);
            // @ts-ignore
            err.code = 'ENOSPC';
            throw err;
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [secretPath, 'ENOSPC', '/Users/private', TOKEN],
        });
        return true;
      },
    );
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
  });

  it('advanceBoundary failure after publish: no false ACK; error redacted', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    let published = false;
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary() {
              throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
            },
            async abortSession() {
              return makeSession({ status: 'aborted' });
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            published = true;
            return { stagingRel: 'must-not-appear-in-error' };
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: ['must-not-appear-in-error', 'stagingRel', TOKEN],
        });
        return true;
      },
    );
    assert.equal(published, true, 'publish may run before advance');
  });

  it('rehash/bodyHash step must precede advance: failing hash skips store advance', async () => {
    const session = makeSession();
    const store = makeFakeStore(session);
    /** @type {string[]} */
    const order = [];
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary(input) {
              order.push('advance');
              return store.advanceBoundary(input);
            },
            async abortSession(input) {
              order.push('abort');
              return store.abortSession(input);
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_B,
          tempPublish: async () => {
            order.push('publish');
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, { statusCode: 409 });
        return true;
      },
    );
    assert.ok(!order.includes('advance'));
  });
});

// ── Integration-shaped: preflight then body discipline ──────────────

describe('preflight-before-body discipline (no full body on header fail)', () => {
  it('invalid CL does not attach body consumers when only parseChunkHeaders runs', () => {
    const body = makeBodyStream(Buffer.alloc(32, 0x7a));
    const req = makeReq(validHeaderPairs({ contentLength: '10', size: '11' }));
    // Simulate IncomingMessage-ish: headers + stream methods
    const hybrid = Object.assign(body.stream, {
      rawHeaders: req.rawHeaders,
      headers: req.headers,
      url: req.url,
      method: 'POST',
    });
    const dataListenersBefore = hybrid.listenerCount('data');
    assert.throws(() => parseChunkHeaders(hybrid), (error) => {
      assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
      return true;
    });
    assert.equal(hybrid.listenerCount('data'), dataListenersBefore);
    assert.equal(body.bytesRead, 0);
    body.pushAll();
  });
});

// ── Constants alignment with C2 ─────────────────────────────────────

describe('chunk size contract alignment', () => {
  it('UPLOAD_CHUNK_SIZE is 8 MiB (shared with session store)', () => {
    assert.equal(UPLOAD_CHUNK_SIZE, 8 * 1024 * 1024);
  });

  it('sha256 helper of empty is well-known (sanity for bodyHash fixtures)', () => {
    assert.equal(
      sha256Hex(Buffer.alloc(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

// ── GLM findings regression (RED) ───────────────────────────────────

describe('GLM-P1: ingestChunkBody settles on close without end/error', () => {
  // short timeout so a hung Promise fails the suite instead of hanging the runner
  it(
    'partial body then close-only → unique upload-chunk-invalid, single-settle, no raw leak',
    { timeout: 400 },
    async () => {
      const stream = new Readable({ read() {} });
      let settles = 0;
      queueMicrotask(() => {
        stream.push(Buffer.alloc(3, 0x61));
        // Client aborted transport: close without end/error (no clean EOF).
        stream.emit('close');
      });
      await assert.rejects(
        async () => {
          try {
            await ingestChunkBody(stream, {
              maxBytes: UPLOAD_CHUNK_SIZE,
              expectedSize: 16,
            });
            settles += 1;
          } catch (error) {
            settles += 1;
            throw error;
          }
        },
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
            statusCode: 400,
            retryable: false,
            leakTokens: ['ECONNRESET', 'socket hang up', '/tmp/', TOKEN],
          });
          return true;
        },
      );
      assert.equal(settles, 1, 'must single-settle');
    },
  );

  it(
    'zero-byte body then close-only → unique upload-chunk-invalid, single-settle',
    { timeout: 400 },
    async () => {
      const stream = new Readable({ read() {} });
      let settles = 0;
      queueMicrotask(() => {
        stream.emit('close');
      });
      await assert.rejects(
        async () => {
          try {
            await ingestChunkBody(stream, {
              maxBytes: UPLOAD_CHUNK_SIZE,
              expectedSize: 8,
            });
            settles += 1;
          } catch (error) {
            settles += 1;
            throw error;
          }
        },
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
          return true;
        },
      );
      assert.equal(settles, 1);
    },
  );
});

describe('GLM-P1: offset≠expectedOffset + size≠canon → out-of-order (not integrity)', () => {
  it('file-complete branch: wrong offset AND wrong size → upload-chunk-out-of-order; session frozen', () => {
    // complete file size=10; canon chunk0 size=10 offset=0. Client sends offset=3 size=7.
    // §6.3 rule 4: offset ≠ confirmed/expected boundary → unique out-of-order (not integrity/abort).
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size: 10,
          confirmedBytes: 10,
          confirmedChunks: 1,
          complete: true,
        },
      ],
    });
    const before = JSON.stringify(session);
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            size: 7,
            offset: 3,
            chunkIndex: 0,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(JSON.stringify(session), before, 'must not mutate session/boundary');
  });

  it('prior-confirmed branch: wrong offset AND wrong size → upload-chunk-out-of-order; session frozen', () => {
    // confirmedBytes = 1 full chunk; prior chunk0 expectedOffset=0 canon=8MiB.
    // Client re-sends chunk0 with offset=1 and size=8MiB-1 → rule 4 out-of-order, not integrity.
    const session = makeSession({
      files: [
        {
          fileIndex: 0,
          size: UPLOAD_CHUNK_SIZE * 2,
          confirmedBytes: UPLOAD_CHUNK_SIZE,
          confirmedChunks: 1,
          complete: false,
        },
      ],
    });
    const before = JSON.stringify(session);
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            size: UPLOAD_CHUNK_SIZE - 1,
            offset: 1,
            chunkIndex: 0,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(JSON.stringify(session), before);
  });
});

describe('GLM-P1: downstream integrity LinkeError must abort once (no false ACK)', () => {
  it('tempPublish throws UPLOAD_INTEGRITY_FAILED → abortSession once, no advance, code preserved', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    let abortCalls = 0;
    let advanceCalls = 0;
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary(input) {
              advanceCalls += 1;
              return store.advanceBoundary(input);
            },
            async abortSession(input) {
              abortCalls += 1;
              return store.abortSession(input);
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
        });
        return true;
      },
    );
    assert.equal(abortCalls, 1, 'must abort exactly once on integrity from tempPublish');
    assert.equal(advanceCalls, 0, 'must not advance / false ACK');
    assert.equal(store.session.files[0].confirmedBytes, 0);
  });

  it('advanceBoundary throws UPLOAD_INTEGRITY_FAILED → abortSession once, no false ACK', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    let abortCalls = 0;
    let advanceCalls = 0;
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary() {
              advanceCalls += 1;
              throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
            },
            async abortSession(input) {
              abortCalls += 1;
              return store.abortSession(input);
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => ({ ok: true }),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
        });
        return true;
      },
    );
    assert.equal(advanceCalls, 1, 'advance attempted once then failed');
    assert.equal(abortCalls, 1, 'must abort exactly once after advance integrity failure');
    assert.equal(store.session.files[0].confirmedBytes, 0, 'boundary must not grow on failed advance');
  });
});

describe('GLM-P2: malformed session / invalid internal digests → upload-io-error', () => {
  it('assertContiguousOrder: session null/non-object → unique upload-io-error', () => {
    assert.throws(
      () => assertContiguousOrder(/** @type {any} */ (null), makeIdentity()),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
        });
        return true;
      },
    );
    assert.throws(
      () => assertContiguousOrder(/** @type {any} */ ('not-an-object'), makeIdentity()),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });

  it('assertContiguousOrder: files not an array → unique upload-io-error', () => {
    assert.throws(
      () =>
        assertContiguousOrder(
          /** @type {any} */ ({ ...makeSession(), files: null }),
          makeIdentity(),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
    assert.throws(
      () =>
        assertContiguousOrder(
          /** @type {any} */ ({ ...makeSession(), files: { 0: makeSession().files[0] } }),
          makeIdentity(),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });

  it('commitChunk: non-64-lower-hex bodyHash → upload-io-error; no advance; no input leak', async () => {
    const session = makeSession();
    const store = makeFakeStore(session);
    const badHash = 'NOT-A-VALID-SHA256-DIGEST!!!!!!!!!!!';
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: badHash,
          tempPublish: async () => {
            throw new Error('tempPublish must not run on misuse args');
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [badHash, 'tempPublish must not run'],
        });
        return true;
      },
    );
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
  });

  it('commitChunk: non-64-lower-hex identity.sha256 → upload-io-error; no advance; no input leak', async () => {
    const session = makeSession();
    const store = makeFakeStore(session);
    const badSha = 'D'.repeat(64); // uppercase — not lower hex
    await assert.rejects(
      () =>
        commitChunk({
          store,
          session,
          identity: makeIdentity({ size: 10, sha256: badSha }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => ({ ok: true }),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: [badSha, CHUNK_SHA_A],
        });
        return true;
      },
    );
    assert.ok(!store.calls.some((c) => c.op === 'advanceBoundary'));
  });
});

describe('GLM-P2: rawHeaders odd length / non-string name-value → upload-chunk-invalid', () => {
  it('odd-length rawHeaders → upload-chunk-invalid without reading body', () => {
    const body = makeBodyStream(Buffer.alloc(8, 0x71));
    const pairs = validHeaderPairs();
    const raw = rawFromPairs(pairs);
    // Truncate to odd length (drop final value) → unpaired name.
    const odd = raw.slice(0, raw.length - 1);
    assert.equal(odd.length % 2, 1);
    const dataBefore = body.stream.listenerCount('data');
    assert.throws(
      () => parseChunkHeaders(odd),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.equal(body.bytesRead, 0);
    assert.equal(body.stream.listenerCount('data'), dataBefore);
  });

  it('non-string header name or value → upload-chunk-invalid without reading body', () => {
    const body = makeBodyStream(Buffer.alloc(8, 0x72));
    const raw = rawFromPairs(validHeaderPairs());
    // Inject a non-string value for Content-Length (keep pair structure).
    const idx = raw.findIndex((v, i) => i % 2 === 0 && String(v).toLowerCase() === 'content-length');
    assert.ok(idx >= 0);
    /** @type {any[]} */
    const hostile = raw.slice();
    hostile[idx + 1] = 10; // number, not string
    const dataBefore = body.stream.listenerCount('data');
    assert.throws(
      () => parseChunkHeaders(/** @type {any} */ (hostile)),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.equal(body.bytesRead, 0);
    assert.equal(body.stream.listenerCount('data'), dataBefore);

    // Non-string name
    /** @type {any[]} */
    const hostileName = rawFromPairs(validHeaderPairs());
    hostileName[0] = 12345;
    assert.throws(
      () => parseChunkHeaders(/** @type {any} */ (hostileName)),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    assert.equal(body.bytesRead, 0);
  });
});

// ── GLM round-3 findings (A/B/C accepted RED; D rejected freeze GREEN) ─

describe('GLM-R3-A: non-contiguous fileIndex must not fallback to array slot', () => {
  it('missing fileIndex=1 with files {0,2,4} → upload-chunk-out-of-order; session frozen', () => {
    // Reproduces files.find(...) ?? files[fileIndex] bug: identity.fileIndex=1 would
    // incorrectly fall back to array slot 1 which holds {fileIndex:2} and may mis-accept
    // as expected/duplicate against the wrong file boundary.
    const session = makeSession({
      status: 'receiving',
      files: [
        {
          fileIndex: 0,
          size: 10,
          confirmedBytes: 0,
          confirmedChunks: 0,
          complete: false,
        },
        {
          fileIndex: 2,
          size: 10,
          confirmedBytes: 0,
          confirmedChunks: 0,
          complete: false,
        },
        {
          fileIndex: 4,
          size: UPLOAD_CHUNK_SIZE + 5,
          confirmedBytes: UPLOAD_CHUNK_SIZE,
          confirmedChunks: 1,
          complete: false,
        },
      ],
    });
    const before = JSON.stringify(session);
    // Hostile request for absent fileIndex 1 with coords that would be "expected"
    // if wrongly mapped onto files[1] === {fileIndex:2, size:10, confirmed:0}.
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            fileIndex: 1,
            chunkIndex: 0,
            offset: 0,
            size: 10,
          }),
        ),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(JSON.stringify(session), before, 'must not mutate session/boundaries');

    // Same gap must not be treated as exact-duplicate of files[1]'s empty progress either.
    assert.throws(
      () =>
        assertContiguousOrder(
          session,
          makeIdentity({
            fileIndex: 1,
            chunkIndex: 0,
            offset: 0,
            size: 10,
            sha256: CHUNK_SHA_A,
          }),
        ),
      (error) => {
        assert.equal(error.code, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
        return true;
      },
    );
    assert.equal(JSON.stringify(session), before);
  });
});

describe('GLM-R3-B: pure helper syntax-illegal coordinates → upload-chunk-invalid', () => {
  const session = () =>
    makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });

  /** Hostile values that are not strict non-negative safe integers. */
  const HOSTILE = Object.freeze([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]);

  for (const field of ['fileIndex', 'chunkIndex', 'offset']) {
    for (const bad of HOSTILE) {
      it(`${field}=${String(bad)} → unique upload-chunk-invalid; session frozen`, () => {
        const s = session();
        const before = JSON.stringify(s);
        const identity = makeIdentity({ size: 10, offset: 0, chunkIndex: 0, fileIndex: 0 });
        identity[field] = bad;
        assert.throws(
          () => assertContiguousOrder(s, identity),
          (error) => {
            assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
              statusCode: 400,
              retryable: false,
            });
            return true;
          },
        );
        assert.equal(JSON.stringify(s), before);
      });
    }
  }
});

describe('GLM-R3-C: duplicate must force verify-existing + valid existingSha256', () => {
  function completeSession() {
    return makeSession({
      status: 'receiving',
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 10, confirmedChunks: 1, complete: true }],
    });
  }

  it('expected path invokes tempPublish once with mode publish-new', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    /** @type {unknown[]} */
    const modes = [];
    await commitChunk({
      store,
      session,
      identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
      bodyHash: CHUNK_SHA_A,
      tempPublish: async (context) => {
        modes.push(context?.mode);
        return { ok: true };
      },
    });
    assert.deepEqual(modes, ['publish-new']);
  });

  it('duplicate path invokes tempPublish once with mode verify-existing', async () => {
    const session = completeSession();
    const store = makeFakeStore(session);
    /** @type {unknown[]} */
    const modes = [];
    await commitChunk({
      store,
      session,
      identity: makeIdentity({ size: 10, offset: 0, chunkIndex: 0, sha256: CHUNK_SHA_A }),
      bodyHash: CHUNK_SHA_A,
      tempPublish: async (context) => {
        modes.push(context?.mode);
        return { existingSha256: CHUNK_SHA_A };
      },
    });
    assert.deepEqual(modes, ['verify-existing']);
  });

  for (const [label, result] of [
    ['empty object {}', {}],
    ['null', null],
    ['missing existingSha256', { ok: true }],
    ['uppercase existingSha256', { existingSha256: 'A'.repeat(64) }],
    ['short existingSha256', { existingSha256: 'ab' }],
    ['non-string existingSha256', { existingSha256: 123 }],
  ]) {
    it(`duplicate verify result ${label} → upload-io-error; no advance; no abort; no false ACK`, async () => {
      const session = completeSession();
      const store = makeFakeStore(session);
      let abortCalls = 0;
      let advanceCalls = 0;
      /** @type {unknown[]} */
      const modes = [];
      const confirmedBefore = session.files[0].confirmedBytes;
      await assert.rejects(
        () =>
          commitChunk({
            store: {
              async advanceBoundary(input) {
                advanceCalls += 1;
                return store.advanceBoundary(input);
              },
              async abortSession(input) {
                abortCalls += 1;
                return store.abortSession(input);
              },
            },
            session,
            identity: makeIdentity({ size: 10, offset: 0, chunkIndex: 0, sha256: CHUNK_SHA_A }),
            bodyHash: CHUNK_SHA_A,
            // Do not assert/throw inside tempPublish: AssertionError would be
            // sanitized to upload-io-error and fake-green the result-schema checks.
            tempPublish: async (context) => {
              modes.push(context?.mode);
              return result;
            },
          }),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
            statusCode: 500,
            retryable: false,
            leakTokens: ['existingSha256', 'AAAA', TOKEN, '/staging/'],
          });
          return true;
        },
      );
      // Assert mode after rejects so missing context is a real failure, not a masked throw.
      assert.deepEqual(modes, ['verify-existing']);
      assert.equal(advanceCalls, 0, 'must not advance / false ACK');
      assert.equal(abortCalls, 0, 'I/O verify failure must not abort resumable session');
      assert.equal(store.session.files[0].confirmedBytes, confirmedBefore);
      assert.equal(store.session.status, 'receiving');
    });
  }
});

describe('GLM-R3-D (rejected freeze): plain tempPublish errors must not abort', () => {
  it('expected tempPublish throws Error → upload-io-error; 0 advance; 0 abort; no leak', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    let abortCalls = 0;
    let advanceCalls = 0;
    const secret = '/Users/private/staging/chunk-0.part';
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary(input) {
              advanceCalls += 1;
              return store.advanceBoundary(input);
            },
            async abortSession(input) {
              abortCalls += 1;
              return store.abortSession(input);
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            throw new Error(`ENOSPC at ${secret}`);
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          retryable: false,
          leakTokens: [secret, 'ENOSPC', '/Users/private'],
        });
        return true;
      },
    );
    assert.equal(advanceCalls, 0);
    assert.equal(abortCalls, 0, 'plain I/O must not destroy resumable session');
    assert.equal(store.session.files[0].confirmedBytes, 0);
    assert.notEqual(store.session.status, 'aborted');
  });

  it('expected tempPublish throws TypeError → upload-io-error; 0 advance; 0 abort', async () => {
    const session = makeSession({
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
    const store = makeFakeStore(session);
    let abortCalls = 0;
    let advanceCalls = 0;
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary(input) {
              advanceCalls += 1;
              return store.advanceBoundary(input);
            },
            async abortSession(input) {
              abortCalls += 1;
              return store.abortSession(input);
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async () => {
            throw new TypeError('cannot read property of undefined');
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: ['cannot read property', 'undefined'],
        });
        return true;
      },
    );
    assert.equal(advanceCalls, 0);
    assert.equal(abortCalls, 0);
  });
});

// ── GLM final-PASS residual P2: publish-new result schema ───────────
// C2 advanceBoundary does not rehash disk; publish-new callback owns
// "written content matches bodyHash/identity.sha256" as a hard dependency.

describe('GLM-P2: publish-new result schema (existingSha256 present vs absent)', () => {
  function freshSession() {
    return makeSession({
      status: 'initialized',
      files: [{ fileIndex: 0, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false }],
    });
  }

  /**
   * @param {unknown} publishResult
   * @param {{
   *   store?: ReturnType<typeof makeFakeStore>,
   *   abortCalls?: { n: number },
   *   advanceCalls?: { n: number },
   * }} [track]
   */
  async function commitExpected(publishResult, track = {}) {
    const session = freshSession();
    const store = track.store ?? makeFakeStore(session);
    const abortCalls = track.abortCalls ?? { n: 0 };
    const advanceCalls = track.advanceCalls ?? { n: 0 };
    /** @type {unknown[]} */
    const modes = [];
    const result = await commitChunk({
      store: {
        async advanceBoundary(input) {
          advanceCalls.n += 1;
          return store.advanceBoundary(input);
        },
        async abortSession(input) {
          abortCalls.n += 1;
          return store.abortSession(input);
        },
      },
      session,
      identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
      bodyHash: CHUNK_SHA_A,
      tempPublish: async (context) => {
        modes.push(context?.mode);
        return publishResult;
      },
    });
    assert.deepEqual(modes, ['publish-new']);
    return { result, store, abortCalls, advanceCalls, session };
  }

  it('publish-new matching existingSha256 → advance once; 0 abort (collision/crash retry)', async () => {
    const track = { abortCalls: { n: 0 }, advanceCalls: { n: 0 } };
    const { result, store } = await commitExpected(
      { existingSha256: CHUNK_SHA_A },
      track,
    );
    assert.equal(track.advanceCalls.n, 1);
    assert.equal(track.abortCalls.n, 0);
    assert.equal(result.files[0].confirmedBytes, 10);
    assert.equal(store.session.files[0].confirmedBytes, 10);
  });

  it('publish-new legal-but-different existingSha256 → integrity+abort; 0 advance', async () => {
    const session = freshSession();
    const store = makeFakeStore(session);
    let abortCalls = 0;
    let advanceCalls = 0;
    await assert.rejects(
      () =>
        commitChunk({
          store: {
            async advanceBoundary(input) {
              advanceCalls += 1;
              return store.advanceBoundary(input);
            },
            async abortSession(input) {
              abortCalls += 1;
              return store.abortSession(input);
            },
          },
          session,
          identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
          bodyHash: CHUNK_SHA_A,
          tempPublish: async (context) => {
            void context?.mode;
            return { existingSha256: CHUNK_SHA_B };
          },
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
          leakTokens: [CHUNK_SHA_A, CHUNK_SHA_B],
        });
        return true;
      },
    );
    assert.equal(advanceCalls, 0);
    assert.equal(abortCalls, 1);
    assert.equal(store.session.files[0].confirmedBytes, 0);
  });

  for (const [label, publishResult] of [
    ['uppercase existingSha256', { existingSha256: 'A'.repeat(64) }],
    ['short existingSha256', { existingSha256: 'ab' }],
    ['non-string existingSha256', { existingSha256: 42 }],
    [
      'getter-throw existingSha256',
      {
        get existingSha256() {
          throw new Error('hostile-getter-must-not-leak');
        },
      },
    ],
  ]) {
    it(`publish-new present-but-malformed (${label}) → upload-io-error; 0 abort/advance`, async () => {
      // Present existingSha256 must not be treated as absent; schema violation is io-error.
      const session = freshSession();
      const store = makeFakeStore(session);
      let abortCalls = 0;
      let advanceCalls = 0;
      await assert.rejects(
        () =>
          commitChunk({
            store: {
              async advanceBoundary(input) {
                advanceCalls += 1;
                return store.advanceBoundary(input);
              },
              async abortSession(input) {
                abortCalls += 1;
                return store.abortSession(input);
              },
            },
            session,
            identity: makeIdentity({ size: 10, sha256: CHUNK_SHA_A }),
            bodyHash: CHUNK_SHA_A,
            tempPublish: async (context) => {
              // Record mode without asserting inside (avoid fake-green via sanitized throw).
              void context?.mode;
              return publishResult;
            },
          }),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
            statusCode: 500,
            retryable: false,
            leakTokens: ['hostile-getter-must-not-leak', 'AAAA', TOKEN, '/staging/'],
          });
          return true;
        },
      );
      assert.equal(advanceCalls, 0, 'must not advance on malformed present existingSha256');
      assert.equal(abortCalls, 0, 'schema violation is not integrity conflict');
      assert.equal(store.session.files[0].confirmedBytes, 0);
      assert.notEqual(store.session.status, 'aborted');
    });
  }

  it('publish-new null = absent → advance (callback already published under contract)', async () => {
    const track = { abortCalls: { n: 0 }, advanceCalls: { n: 0 } };
    const { result } = await commitExpected(null, track);
    assert.equal(track.advanceCalls.n, 1);
    assert.equal(track.abortCalls.n, 0);
    assert.equal(result.files[0].confirmedBytes, 10);
  });

  it('publish-new {ok:true} = absent existingSha256 → advance (frozen dependency, not fail-open)', async () => {
    // C2 advanceBoundary does not rehash; tempPublish(publish-new) is the hard
    // dependency that the written content matches bodyHash/identity.sha256.
    const track = { abortCalls: { n: 0 }, advanceCalls: { n: 0 } };
    const { result } = await commitExpected({ ok: true }, track);
    assert.equal(track.advanceCalls.n, 1);
    assert.equal(track.abortCalls.n, 0);
    assert.equal(result.files[0].confirmedBytes, 10);
  });
});
