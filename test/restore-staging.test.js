/**
 * RED tests for G0c C3 endpoint staging helpers (design §§6.3–6.4, 7.6–7.7, 10.4, 12.5).
 *
 * Production module intentionally absent at RED → ERR_MODULE_NOT_FOUND.
 * Real temp dirs; independent fixtures; strong behavioral asserts; no skips; no algo tautology.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { RESTORE_CHUNK_SIZE } from '../src/restore-schemas.js';
import {
  deriveSiblingNames,
  preflightTarget,
  materializeChunkToStaging,
  verifyStagingTree,
  assertCapacity,
} from '../src/restore-staging.js';

const TASK_INVALID = ERROR_CODES.RESTORE_TASK_INVALID;
const PATH_INVALID = ERROR_CODES.RESTORE_PATH_INVALID;
const INTEGRITY_FAILED = ERROR_CODES.RESTORE_INTEGRITY_FAILED;
const CAPACITY_INSUFFICIENT = ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT;

const TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const HEX64_RE = /^[a-f0-9]{64}$/;
const MI_64 = 64 * 1024 * 1024;

/** @type {string | undefined} */
let tempRoot;

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, `expected LinkeError ${code}, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);

  // Public surface only: message/code/name/status/retryable + own enumerable fields.
  // Do NOT scan err.stack — Node debug stacks naturally contain workspace paths under
  // /Users/.../src|test; design non-leak is wire/log/public fields, not V8 stack frames.
  const ownPublic = Object.keys(/** @type {object} */ (error))
    .filter((k) => k !== 'stack')
    .map((k) => String(/** @type {Record<string, unknown>} */ (error)[k]));
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    ...ownPublic,
  ].join('\0');

  const denylist = [
    ...(opts.leakTokens ?? []),
    tempRoot ?? '',
    '/Users/',
    'secret-token',
    'ENOENT',
    'EACCES',
    'EPERM',
    'errno',
    'GETTER_SENTINEL',
  ].filter(Boolean);

  for (const token of denylist) {
    if (String(token).length < 2) continue;
    if (code.includes(String(token))) continue;
    assert.ok(!publicParts.includes(String(token)), `must not leak ${token}`);
  }
}

/**
 * @param {() => unknown} fn
 * @param {string} code
 * @param {{ statusCode?: number | null, leakTokens?: string[] }} [opts]
 */
function expectThrows(fn, code, opts = {}) {
  assert.throws(fn, (error) => {
    assertLinkeCode(error, code, opts);
    return true;
  });
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} code
 * @param {{ statusCode?: number | null, leakTokens?: string[] }} [opts]
 */
async function expectRejects(fn, code, opts = {}) {
  await assert.rejects(fn, (error) => {
    assertLinkeCode(error, code, opts);
    return true;
  });
}

/**
 * @param {Buffer | string} bytes
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Independent requiredBytes oracle from design §12.5 (formula pin only — not production module).
 * @param {number} remainingStagingBytes
 * @param {number} totalBytes
 */
function requiredBytesOracle(remainingStagingBytes, totalBytes) {
  return remainingStagingBytes + Math.max(MI_64, Math.ceil(totalBytes * 0.05));
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'linke-stg-'));
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

// ── 10. deriveSiblingNames ─────────────────────────────────────────

describe('deriveSiblingNames', () => {
  it('accepts lowercase UUID and returns exact frozen sibling names', () => {
    const names = deriveSiblingNames(TASK_ID);
    assert.ok(Object.isFrozen(names));
    assert.deepEqual(Object.keys(names).sort(), [
      'anchorName',
      'quarantineName',
      'stagingName',
    ]);
    assert.equal(names.stagingName, `.${TASK_ID}.linke-restore-staging`);
    assert.equal(names.anchorName, `.${TASK_ID}.linke-restore-anchor`);
    assert.equal(names.quarantineName, `.${TASK_ID}.linke-restore-quarantine`);
    assert.throws(() => {
      /** @type {Record<string, string>} */ (names).stagingName = 'x';
    }, TypeError);
  });

  it('rejects uppercase / non-UUID / path characters with RESTORE_TASK_INVALID', () => {
    const badIds = [
      '550E8400-E29B-41D4-A716-446655440001', // uppercase
      'not-a-uuid',
      '',
      '550e8400-e29b-41d4-a716-446655440001/../x',
      '550e8400-e29b-41d4-a716-446655440001/x',
      '../550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440001\0',
      '550e8400-e29b-61d4-a716-446655440001', // wrong version nibble if strict UUID RFC
      12,
      null,
      undefined,
      {},
      [],
    ];
    for (const id of badIds) {
      expectThrows(() => deriveSiblingNames(/** @type {any} */ (id)), TASK_INVALID, {
        statusCode: 400,
        leakTokens: [String(id ?? ''), '/Users/', tempRoot ?? ''],
      });
    }
  });
});

// ── 11. preflightTarget ────────────────────────────────────────────

describe('preflightTarget', () => {
  it('returns exact in-process abs fields + originalTargetExisted + dev for valid target', async () => {
    const restoreRoot = join(/** @type {string} */ (tempRoot), 'restore-root');
    await mkdir(restoreRoot, { recursive: true });
    const relativeTarget = 'docs/restore-target';
    const targetAbs = join(restoreRoot, relativeTarget);
    await mkdir(targetAbs, { recursive: true });
    await writeFile(join(targetAbs, 'old.txt'), 'old');

    // taskId is required to derive sibling staging/anchor/quarantine names (design §6.3).
    const result = await preflightTarget({
      restoreRoot,
      relativeTarget,
      taskId: TASK_ID,
    });
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result).sort(), [
      'anchorPathAbs',
      'originalTargetExisted',
      'parentDev',
      'parentPathAbs',
      'quarantinePathAbs',
      'stagingPathAbs',
      'targetDev',
      'targetPathAbs',
    ]);

    assert.equal(result.targetPathAbs, resolve(targetAbs));
    assert.equal(result.parentPathAbs, resolve(dirname(targetAbs)));
    assert.equal(result.originalTargetExisted, true);
    assert.equal(typeof result.parentDev, 'number');
    assert.equal(typeof result.targetDev, 'number');
    assert.equal(result.parentDev, result.targetDev);

    const names = deriveSiblingNames(TASK_ID);
    assert.equal(result.stagingPathAbs, join(result.parentPathAbs, names.stagingName));
    assert.equal(result.anchorPathAbs, join(result.parentPathAbs, names.anchorName));
    assert.equal(result.quarantinePathAbs, join(result.parentPathAbs, names.quarantineName));
    assert.equal(dirname(result.stagingPathAbs), result.parentPathAbs);
    assert.equal(basename(result.stagingPathAbs), names.stagingName);
    assert.equal(basename(result.anchorPathAbs), names.anchorName);
    assert.equal(basename(result.quarantinePathAbs), names.quarantineName);

    // Abs must not be left on disk as durable artifacts from preflight itself.
    const rootListing = await readdir(/** @type {string} */ (tempRoot), { recursive: true });
    assert.equal(
      rootListing.some((e) => String(e).includes('linke-restore-staging')),
      false,
    );
  });

  it('originalTargetExisted=false when target absent; parent must exist same-device', async () => {
    const restoreRoot = join(/** @type {string} */ (tempRoot), 'rr');
    await mkdir(join(restoreRoot, 'docs'), { recursive: true });
    const result = await preflightTarget({
      restoreRoot,
      relativeTarget: 'docs/new-target',
      taskId: TASK_ID,
    });
    assert.equal(result.originalTargetExisted, false);
    assert.equal(result.targetDev, null);
    assert.equal(typeof result.parentDev, 'number');
    assert.equal(result.targetPathAbs, resolve(restoreRoot, 'docs/new-target'));
  });

  it('rejects unsafe relativeTarget / symlink ancestors / escape with sole RESTORE_PATH_INVALID', async () => {
    const restoreRoot = join(/** @type {string} */ (tempRoot), 'rr2');
    await mkdir(restoreRoot, { recursive: true });

    const badTargets = [
      '',
      '/abs',
      'a//b',
      'a/../b',
      '../x',
      'a\\b',
      'a/\0b',
      'a/\nb',
      '.',
      '..',
    ];
    for (const relativeTarget of badTargets) {
      await expectRejects(
        () =>
          preflightTarget({
            restoreRoot,
            relativeTarget,
            taskId: TASK_ID,
          }),
        PATH_INVALID,
        {
          statusCode: 400,
          leakTokens: [relativeTarget, restoreRoot, '/Users/'],
        },
      );
    }

    // Ancestor symlink
    const outside = join(/** @type {string} */ (tempRoot), 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(restoreRoot, 'docs'), 'dir');
    await expectRejects(
      () =>
        preflightTarget({
          restoreRoot,
          relativeTarget: 'docs/t',
          taskId: TASK_ID,
        }),
      PATH_INVALID,
      { statusCode: 400, leakTokens: [restoreRoot, outside, 'docs'] },
    );

    // Missing parent of multi-segment target: parent-of-target must exist (design §6.3/§10.4).
    await expectRejects(
      () =>
        preflightTarget({
          restoreRoot: join(/** @type {string} */ (tempRoot), 'empty-root-only'),
          relativeTarget: 'missing-parent/target',
          taskId: TASK_ID,
        }),
      PATH_INVALID,
      { statusCode: 400 },
    );

    // Invalid taskId for sibling derivation → path/task invalid surface (unique PATH_INVALID for preflight).
    await expectRejects(
      () =>
        preflightTarget({
          restoreRoot,
          relativeTarget: 'docs/ok',
          taskId: 'NOT-UUID',
        }),
      PATH_INVALID,
      { statusCode: 400, leakTokens: ['NOT-UUID', restoreRoot] },
    );
  });

  it('does not persist absolute paths into any durable JSON under restoreRoot', async () => {
    const restoreRoot = join(/** @type {string} */ (tempRoot), 'rr3');
    await mkdir(join(restoreRoot, 'docs'), { recursive: true });
    await preflightTarget({
      restoreRoot,
      relativeTarget: 'docs/t',
      taskId: TASK_ID,
    });

    async function collectFiles(dir, acc = []) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await collectFiles(p, acc);
        else acc.push(p);
      }
      return acc;
    }
    const files = await collectFiles(restoreRoot);
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      assert.ok(!text.includes(restoreRoot), 'must not write restoreRoot abs into files');
      assert.ok(!text.includes('targetPathAbs'));
      assert.ok(!text.includes('stagingPathAbs'));
    }
  });
});

// ── 12. materializeChunkToStaging ──────────────────────────────────

describe('materializeChunkToStaging', () => {
  it('creates tree no-follow with dir 0700 / file 0600; writes full chunk and is idempotent', async () => {
    const stagingRoot = join(/** @type {string} */ (tempRoot), 'staging');
    await mkdir(stagingRoot, { mode: 0o700 });

    const payload = Buffer.alloc(1024, 0x5a);
    const expectedSha256 = sha256Hex(payload);
    assert.match(expectedSha256, HEX64_RE);

    await materializeChunkToStaging({
      stagingRoot,
      filePath: 'nested/dir/file.bin',
      chunkIndex: 0,
      chunkSize: RESTORE_CHUNK_SIZE,
      bytes: payload,
      expectedSha256,
    });

    const abs = join(stagingRoot, 'nested/dir/file.bin');
    const st = await lstat(abs);
    assert.ok(st.isFile());
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.size, payload.length);
    assert.deepEqual(await readFile(abs), payload);

    const dirStat = await lstat(join(stagingRoot, 'nested/dir'));
    assert.ok(dirStat.isDirectory());
    assert.equal(dirStat.mode & 0o777, 0o700);
    const midStat = await lstat(join(stagingRoot, 'nested'));
    assert.equal(midStat.mode & 0o777, 0o700);

    // Idempotent same content
    await materializeChunkToStaging({
      stagingRoot,
      filePath: 'nested/dir/file.bin',
      chunkIndex: 0,
      chunkSize: RESTORE_CHUNK_SIZE,
      bytes: payload,
      expectedSha256,
    });
    assert.deepEqual(await readFile(abs), payload);
  });

  it('appends subsequent chunks at correct offsets for multi-chunk files', async () => {
    const stagingRoot = join(/** @type {string} */ (tempRoot), 'staging-mc');
    await mkdir(stagingRoot, { mode: 0o700 });

    const chunk0 = Buffer.alloc(RESTORE_CHUNK_SIZE, 0x11);
    const chunk1 = Buffer.alloc(100, 0x22);
    const sha0 = sha256Hex(chunk0);
    const sha1 = sha256Hex(chunk1);

    await materializeChunkToStaging({
      stagingRoot,
      filePath: 'big.bin',
      chunkIndex: 0,
      chunkSize: RESTORE_CHUNK_SIZE,
      bytes: chunk0,
      expectedSha256: sha0,
    });
    await materializeChunkToStaging({
      stagingRoot,
      filePath: 'big.bin',
      chunkIndex: 1,
      chunkSize: RESTORE_CHUNK_SIZE,
      bytes: chunk1,
      expectedSha256: sha1,
    });

    const onDisk = await readFile(join(stagingRoot, 'big.bin'));
    assert.equal(onDisk.length, RESTORE_CHUNK_SIZE + 100);
    assert.deepEqual(onDisk.subarray(0, RESTORE_CHUNK_SIZE), chunk0);
    assert.deepEqual(onDisk.subarray(RESTORE_CHUNK_SIZE), chunk1);
  });

  it('rejects sha mismatch / wrong length / bad indexes / conflict / symlink with INTEGRITY_FAILED', async () => {
    const stagingRoot = join(/** @type {string} */ (tempRoot), 'staging-bad');
    await mkdir(stagingRoot, { mode: 0o700 });
    const payload = Buffer.from('chunk-payload-xyz');
    const goodSha = sha256Hex(payload);

    // SHA mismatch
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: 'a.bin',
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: payload,
          expectedSha256: '0'.repeat(64),
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot, 'a.bin'] },
    );

    // bytes longer than chunkSize
    const oversize = Buffer.alloc(RESTORE_CHUNK_SIZE + 1, 1);
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: 'b.bin',
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: oversize,
          expectedSha256: sha256Hex(oversize),
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot] },
    );

    // negative / non-int chunkIndex
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: 'c.bin',
          chunkIndex: -1,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: payload,
          expectedSha256: goodSha,
        }),
      INTEGRITY_FAILED,
      { statusCode: 422 },
    );

    // unsafe filePath
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: '../escape.bin',
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: payload,
          expectedSha256: goodSha,
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: ['../escape.bin', stagingRoot] },
    );

    // Different content conflict on same chunk
    await materializeChunkToStaging({
      stagingRoot,
      filePath: 'd.bin',
      chunkIndex: 0,
      chunkSize: RESTORE_CHUNK_SIZE,
      bytes: payload,
      expectedSha256: goodSha,
    });
    const other = Buffer.from('DIFFERENT-PAYLOAD!!');
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: 'd.bin',
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: other,
          expectedSha256: sha256Hex(other),
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot, 'd.bin'] },
    );
    // Original preserved
    assert.deepEqual(await readFile(join(stagingRoot, 'd.bin')), payload);

    // Symlink at destination
    const outside = join(/** @type {string} */ (tempRoot), 'out-secret');
    await writeFile(outside, 'SECRET');
    await symlink(outside, join(stagingRoot, 'link.bin'));
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: 'link.bin',
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: payload,
          expectedSha256: goodSha,
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot, outside, 'SECRET'] },
    );
    assert.equal(await readFile(outside, 'utf8'), 'SECRET');

    // Type swap: directory where file expected
    await mkdir(join(stagingRoot, 'dir-as-file'));
    await expectRejects(
      () =>
        materializeChunkToStaging({
          stagingRoot,
          filePath: 'dir-as-file',
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: payload,
          expectedSha256: goodSha,
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot] },
    );
  });
});

// ── 13. verifyStagingTree ──────────────────────────────────────────

describe('verifyStagingTree', () => {
  it('accepts exact nested tree including empty file', async () => {
    const stagingRoot = join(/** @type {string} */ (tempRoot), 'v-ok');
    await mkdir(stagingRoot, { mode: 0o700 });
    const empty = Buffer.alloc(0);
    const body = Buffer.from('hello-staging');
    await mkdir(join(stagingRoot, 'nested'), { recursive: true, mode: 0o700 });
    await writeFile(join(stagingRoot, 'empty.txt'), empty, { mode: 0o600 });
    await writeFile(join(stagingRoot, 'nested/a.txt'), body, { mode: 0o600 });

    await verifyStagingTree({
      stagingRoot,
      files: [
        { path: 'empty.txt', size: 0, sha256: sha256Hex(empty) },
        { path: 'nested/a.txt', size: body.length, sha256: sha256Hex(body) },
      ],
    });
  });

  it('missing / extra / short / long / wrong sha / symlink / nonregular → INTEGRITY_FAILED', async () => {
    const stagingRoot = join(/** @type {string} */ (tempRoot), 'v-bad');
    await mkdir(stagingRoot, { mode: 0o700 });
    const body = Buffer.from('abc');
    await writeFile(join(stagingRoot, 'a.txt'), body, { mode: 0o600 });

    // Missing
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [
            { path: 'a.txt', size: 3, sha256: sha256Hex(body) },
            { path: 'missing.txt', size: 0, sha256: sha256Hex(Buffer.alloc(0)) },
          ],
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot, 'missing.txt'] },
    );

    // Extra file on disk not in files list
    await writeFile(join(stagingRoot, 'extra.txt'), 'x', { mode: 0o600 });
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [{ path: 'a.txt', size: 3, sha256: sha256Hex(body) }],
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot, 'extra.txt'] },
    );
    await rm(join(stagingRoot, 'extra.txt'));

    // Short
    await writeFile(join(stagingRoot, 'a.txt'), Buffer.from('ab'), { mode: 0o600 });
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [{ path: 'a.txt', size: 3, sha256: sha256Hex(body) }],
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot] },
    );

    // Long
    await writeFile(join(stagingRoot, 'a.txt'), Buffer.from('abcd'), { mode: 0o600 });
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [{ path: 'a.txt', size: 3, sha256: sha256Hex(body) }],
        }),
      INTEGRITY_FAILED,
      { statusCode: 422 },
    );

    // Wrong sha, correct size
    await writeFile(join(stagingRoot, 'a.txt'), Buffer.from('xyz'), { mode: 0o600 });
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [{ path: 'a.txt', size: 3, sha256: sha256Hex(body) }],
        }),
      INTEGRITY_FAILED,
      { statusCode: 422 },
    );

    // Symlink
    await rm(join(stagingRoot, 'a.txt'));
    const outside = join(/** @type {string} */ (tempRoot), 'v-out');
    await writeFile(outside, body);
    await symlink(outside, join(stagingRoot, 'a.txt'));
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [{ path: 'a.txt', size: 3, sha256: sha256Hex(body) }],
        }),
      INTEGRITY_FAILED,
      { statusCode: 422, leakTokens: [stagingRoot, outside] },
    );
  });

  it('does not leak absolute paths in errors', async () => {
    const stagingRoot = join(/** @type {string} */ (tempRoot), 'v-leak');
    await mkdir(stagingRoot, { mode: 0o700 });
    await expectRejects(
      () =>
        verifyStagingTree({
          stagingRoot,
          files: [{ path: 'gone.txt', size: 1, sha256: 'a'.repeat(64) }],
        }),
      INTEGRITY_FAILED,
      {
        statusCode: 422,
        leakTokens: [stagingRoot, /** @type {string} */ (tempRoot), '/Users/'],
      },
    );
  });
});

// ── 14. assertCapacity ─────────────────────────────────────────────

describe('assertCapacity — single formula, no oldTargetBytes', () => {
  it('uses required=remainingStagingBytes+max(64MiB,ceil(totalBytes*0.05)); exact equal passes', () => {
    // totalBytes small → reserve is 64MiB
    const remaining = 1_000_000;
    const totalBytes = 1000;
    const required = requiredBytesOracle(remaining, totalBytes);
    assert.equal(required, remaining + MI_64);

    assert.doesNotThrow(() =>
      assertCapacity({
        remainingStagingBytes: remaining,
        totalBytes,
        freeBytes: required,
      }),
    );
    assert.doesNotThrow(() =>
      assertCapacity({
        remainingStagingBytes: remaining,
        totalBytes,
        freeBytes: required + 1,
      }),
    );

    // totalBytes large → 5% dominates
    const bigTotal = MI_64 * 40; // 2.5 GiB → 5% = 128 MiB > 64 MiB
    const rem2 = 10;
    const req2 = requiredBytesOracle(rem2, bigTotal);
    assert.equal(req2, rem2 + Math.ceil(bigTotal * 0.05));
    assert.ok(Math.ceil(bigTotal * 0.05) > MI_64);
    assert.doesNotThrow(() =>
      assertCapacity({
        remainingStagingBytes: rem2,
        totalBytes: bigTotal,
        freeBytes: req2,
      }),
    );
  });

  it('freeBytes===null or insufficient → CAPACITY_INSUFFICIENT', () => {
    const remaining = 100;
    const totalBytes = 0;
    const required = requiredBytesOracle(remaining, totalBytes);

    expectThrows(
      () =>
        assertCapacity({
          remainingStagingBytes: remaining,
          totalBytes,
          freeBytes: null,
        }),
      CAPACITY_INSUFFICIENT,
      { statusCode: 507 },
    );

    expectThrows(
      () =>
        assertCapacity({
          remainingStagingBytes: remaining,
          totalBytes,
          freeBytes: required - 1,
        }),
      CAPACITY_INSUFFICIENT,
      { statusCode: 507 },
    );

    expectThrows(
      () =>
        assertCapacity({
          remainingStagingBytes: remaining,
          totalBytes,
          freeBytes: 0,
        }),
      CAPACITY_INSUFFICIENT,
      { statusCode: 507 },
    );
  });

  it('rejects oldTargetBytes / unknown keys / non-safe-int / negative with fixed errors', () => {
    // Unknown keys / oldTargetBytes must not be accepted (fail closed).
    expectThrows(
      () =>
        assertCapacity(
          /** @type {any} */ ({
            remainingStagingBytes: 0,
            totalBytes: 0,
            freeBytes: MI_64,
            oldTargetBytes: 999,
          }),
        ),
      TASK_INVALID,
      { statusCode: 400, leakTokens: ['oldTargetBytes'] },
    );
    expectThrows(
      () =>
        assertCapacity(
          /** @type {any} */ ({
            remainingStagingBytes: 0,
            totalBytes: 0,
            freeBytes: MI_64,
            evil: true,
          }),
        ),
      TASK_INVALID,
      { statusCode: 400 },
    );

    // Negative / non-safe-int
    for (const bad of [
      { remainingStagingBytes: -1, totalBytes: 0, freeBytes: MI_64 },
      { remainingStagingBytes: 0, totalBytes: -1, freeBytes: MI_64 },
      { remainingStagingBytes: 1.5, totalBytes: 0, freeBytes: MI_64 },
      { remainingStagingBytes: 0, totalBytes: 0, freeBytes: 1.2 },
      { remainingStagingBytes: Number.NaN, totalBytes: 0, freeBytes: MI_64 },
      {
        remainingStagingBytes: Number.MAX_SAFE_INTEGER,
        totalBytes: Number.MAX_SAFE_INTEGER,
        freeBytes: Number.MAX_SAFE_INTEGER,
      },
      { remainingStagingBytes: '0', totalBytes: 0, freeBytes: MI_64 },
    ]) {
      expectThrows(() => assertCapacity(/** @type {any} */ (bad)), TASK_INVALID, {
        statusCode: 400,
      });
    }

    // Must not consult oldTargetBytes even if provided via prototype pollution style.
    const polluted = {
      remainingStagingBytes: 0,
      totalBytes: 0,
      freeBytes: MI_64,
    };
    Object.defineProperty(polluted, 'oldTargetBytes', {
      enumerable: true,
      value: 10 ** 12,
    });
    expectThrows(() => assertCapacity(/** @type {any} */ (polluted)), TASK_INVALID, {
      statusCode: 400,
    });
  });
});
