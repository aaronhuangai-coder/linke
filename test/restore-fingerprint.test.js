/**
 * RED tests for G0c C3 endpoint fingerprint helpers (design §7.9).
 *
 * Production module intentionally absent at RED → ERR_MODULE_NOT_FOUND.
 * Real temp trees; behavioral determinism/sensitivity asserts; no production algo tautology;
 * empty-tree content sha pinned to design constant only.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  computeStructureFingerprint,
  computeContentSha256,
} from '../src/restore-fingerprint.js';

const INTEGRITY_FAILED = ERROR_CODES.RESTORE_INTEGRITY_FAILED;
const EMPTY_CONTENT_SHA =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEX64_RE = /^[a-f0-9]{64}$/;

/** @type {string | undefined} */
let rootDir;

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, `expected LinkeError, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);

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
    rootDir ?? '',
    '/Users/',
    'secret-token',
    'ENOENT',
    'EACCES',
    'EPERM',
    'errno',
    'GETTER_SENTINEL',
    'HASH_BOOM',
    'FS_BOOM',
  ].filter(Boolean);

  for (const token of denylist) {
    if (String(token).length < 2) continue;
    if (code.includes(String(token))) continue;
    assert.ok(!publicParts.includes(String(token)), `must not leak ${token}`);
  }
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} code
 * @param {{ leakTokens?: string[] }} [opts]
 */
async function expectCode(fn, code, opts = {}) {
  await assert.rejects(fn, (error) => {
    assertLinkeCode(error, code, opts);
    return true;
  });
}

/**
 * Independent fixture builder — not fingerprint algorithm.
 * @param {string} root
 * @param {{ path: string, content: string | Buffer }[]} files
 */
async function writeTree(root, files) {
  for (const f of files) {
    const abs = join(root, f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, f.content);
  }
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'linke-fp-'));
});

afterEach(async () => {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  }
});

// ── 1. empty tree constant ─────────────────────────────────────────

describe('computeContentSha256 / computeStructureFingerprint — empty tree', () => {
  it('empty tree contentSha256 is exact design constant; structure is 64 lower hex', async () => {
    const root = /** @type {string} */ (rootDir);
    // Empty directory (no files). Structure still defined over directory set.
    const content = await computeContentSha256(root);
    assert.equal(content, EMPTY_CONTENT_SHA);
    assert.match(content, HEX64_RE);

    const structure = await computeStructureFingerprint(root);
    assert.match(structure, HEX64_RE);
    assert.equal(structure, structure.toLowerCase());
    // Deterministic on empty tree.
    assert.equal(await computeStructureFingerprint(root), structure);
    assert.equal(await computeContentSha256(root), EMPTY_CONTENT_SHA);
  });
});

// ── 2. dual-file / nested determinism + dimension separation ───────

describe('fingerprint determinism and dimension separation', () => {
  it('dual-file nested tree is deterministic; UTF-8 path order stable', async () => {
    const root = /** @type {string} */ (rootDir);
    // Paths chosen so UTF-8 byte order differs from naive locale tricks:
    // 'nested/z.txt' vs 'nested/a.txt' vs top-level 'b.txt' vs multibyte.
    await writeTree(root, [
      { path: 'b.txt', content: 'bravo' },
      { path: 'nested/z.txt', content: 'zulu' },
      { path: 'nested/a.txt', content: 'alpha' },
      { path: '中文/文件.txt', content: 'unicode-payload' },
    ]);

    const s1 = await computeStructureFingerprint(root);
    const s2 = await computeStructureFingerprint(root);
    const c1 = await computeContentSha256(root);
    const c2 = await computeContentSha256(root);

    assert.match(s1, HEX64_RE);
    assert.match(c1, HEX64_RE);
    assert.equal(s1, s2);
    assert.equal(c1, c2);
    assert.equal(s1, s1.toLowerCase());
    assert.equal(c1, c1.toLowerCase());
    assert.notEqual(s1, c1);

    // Re-create identical tree under a fresh root → same fingerprints (path-relative).
    const root2 = await mkdtemp(join(tmpdir(), 'linke-fp2-'));
    try {
      await writeTree(root2, [
        { path: 'b.txt', content: 'bravo' },
        { path: 'nested/z.txt', content: 'zulu' },
        { path: 'nested/a.txt', content: 'alpha' },
        { path: '中文/文件.txt', content: 'unicode-payload' },
      ]);
      assert.equal(await computeStructureFingerprint(root2), s1);
      assert.equal(await computeContentSha256(root2), c1);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('content-only change (same sizes) affects contentSha256 only; structure stays', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [
      { path: 'a.txt', content: '12345' },
      { path: 'dir/b.txt', content: 'ABCDE' },
    ]);
    const structureBefore = await computeStructureFingerprint(root);
    const contentBefore = await computeContentSha256(root);

    // Same length payloads → structure (path+size) unchanged; content hash changes.
    await writeFile(join(root, 'a.txt'), '67890');
    await writeFile(join(root, 'dir/b.txt'), 'FGHIJ');

    const structureAfter = await computeStructureFingerprint(root);
    const contentAfter = await computeContentSha256(root);

    assert.equal(structureAfter, structureBefore);
    assert.notEqual(contentAfter, contentBefore);
    assert.match(contentAfter, HEX64_RE);
  });

  it('structure change (add/remove/resize) affects structureFingerprint', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [
      { path: 'only.txt', content: 'x' },
    ]);
    const structure0 = await computeStructureFingerprint(root);
    const content0 = await computeContentSha256(root);

    // Add file → structure changes.
    await writeTree(root, [{ path: 'extra.txt', content: 'y' }]);
    const structure1 = await computeStructureFingerprint(root);
    const content1 = await computeContentSha256(root);
    assert.notEqual(structure1, structure0);
    assert.notEqual(content1, content0);

    // Resize existing file → structure changes (size in structure record).
    await writeFile(join(root, 'only.txt'), 'longer-content');
    const structure2 = await computeStructureFingerprint(root);
    assert.notEqual(structure2, structure1);

    // Remove extra → structure differs from both 1 and 0 if only.txt size differs from original.
    await rm(join(root, 'extra.txt'));
    const structure3 = await computeStructureFingerprint(root);
    assert.notEqual(structure3, structure1);
    assert.notEqual(structure3, structure0);
  });
});

// ── 3. symlink / nonregular / walk fail-closed ─────────────────────

describe('walk defenses — symlink / nonregular / IO → INTEGRITY_FAILED', () => {
  it('rejects file symlink without following or leaking path', async () => {
    const root = /** @type {string} */ (rootDir);
    const outside = await mkdtemp(join(tmpdir(), 'linke-fp-out-'));
    try {
      const secret = join(outside, 'secret.bin');
      await writeFile(secret, 'TOP-SECRET-TOKEN');
      await writeTree(root, [{ path: 'ok.txt', content: 'ok' }]);
      await symlink(secret, join(root, 'link.txt'));

      await expectCode(() => computeStructureFingerprint(root), INTEGRITY_FAILED, {
        leakTokens: [root, outside, secret, 'TOP-SECRET-TOKEN', 'link.txt'],
      });
      await expectCode(() => computeContentSha256(root), INTEGRITY_FAILED, {
        leakTokens: [root, outside, secret, 'TOP-SECRET-TOKEN'],
      });
      // Outside must remain untouched.
      assert.equal(await readFile(secret, 'utf8'), 'TOP-SECRET-TOKEN');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects directory symlink and ancestor type swap', async () => {
    const root = /** @type {string} */ (rootDir);
    const outside = await mkdtemp(join(tmpdir(), 'linke-fp-dout-'));
    try {
      await writeFile(join(outside, 'x.txt'), 'outside');
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(join(root, 'nested', 'a.txt'), 'in');
      // Replace nested with dir symlink.
      await rm(join(root, 'nested'), { recursive: true, force: true });
      await symlink(outside, join(root, 'nested'), 'dir');

      await expectCode(() => computeStructureFingerprint(root), INTEGRITY_FAILED, {
        leakTokens: [root, outside, 'nested'],
      });
      await expectCode(() => computeContentSha256(root), INTEGRITY_FAILED, {
        leakTokens: [root, outside],
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects FIFO / nonregular nodes with INTEGRITY_FAILED', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [{ path: 'ok.txt', content: 'ok' }]);
    const fifoPath = join(root, 'pipe.fifo');
    // mkfifo via shell-less: use fs if available; skip construction if unsupported but still assert nonregular.
    let createdFifo = false;
    try {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
      createdFifo = r.status === 0;
    } catch {
      createdFifo = false;
    }

    if (createdFifo) {
      await expectCode(() => computeStructureFingerprint(root), INTEGRITY_FAILED, {
        leakTokens: [root, fifoPath, 'pipe.fifo'],
      });
      await expectCode(() => computeContentSha256(root), INTEGRITY_FAILED, {
        leakTokens: [root, fifoPath],
      });
    } else {
      // Fallback nonregular: socket-like via directory named as file conflict — use chmod-only file
      // replaced by a directory entry that is a symlink to a char device is platform-specific.
      // Use a symlink to /dev/null as nonregular surrogate (symlink already covered) —
      // additionally: type-swap file to directory mid-tree path component.
      await mkdir(join(root, 'was-file-path'));
      await writeFile(join(root, 'was-file-path', 'child.txt'), 'c');
      // A plain tree is fine; ensure root itself if swapped to symlink fails.
      const parent = join(/** @type {string} */ (rootDir), '..');
      // Create sibling tree with symlink root component handled by calling with symlink path.
      const linkRoot = join(await mkdtemp(join(tmpdir(), 'linke-fp-linkroot-')), 'link');
      await symlink(root, linkRoot);
      try {
        await expectCode(() => computeStructureFingerprint(linkRoot), INTEGRITY_FAILED, {
          leakTokens: [linkRoot, root],
        });
      } finally {
        await rm(join(linkRoot, '..'), { recursive: true, force: true });
      }
      assert.ok(parent); // keep binding used; silence lint-ish empty
    }
  });
});

// ── 4. injectable fsOps / createHash fail-closed ───────────────────

describe('fsOps / createHash injection fail-closed', () => {
  it('hostile createHash throw → INTEGRITY_FAILED without leak', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [{ path: 'a.txt', content: 'a' }]);

    const hostileCreateHash = () => {
      throw new Error(`HASH_BOOM ${root} secret-token`);
    };

    await expectCode(
      () =>
        computeContentSha256(root, {
          createHash: /** @type {any} */ (hostileCreateHash),
        }),
      INTEGRITY_FAILED,
      { leakTokens: [root, 'HASH_BOOM', 'secret-token'] },
    );
    await expectCode(
      () =>
        computeStructureFingerprint(root, {
          createHash: /** @type {any} */ (hostileCreateHash),
        }),
      INTEGRITY_FAILED,
      { leakTokens: [root, 'HASH_BOOM', 'secret-token'] },
    );
  });

  it('hostile createHash returning non-hash object → INTEGRITY_FAILED', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [{ path: 'a.txt', content: 'a' }]);
    const hostileCreateHash = () => ({
      update() {
        return this;
      },
      digest() {
        return 'not-hex';
      },
    });
    await expectCode(
      () =>
        computeContentSha256(root, {
          createHash: /** @type {any} */ (hostileCreateHash),
        }),
      INTEGRITY_FAILED,
      { leakTokens: [root, 'not-hex'] },
    );
  });

  it('hostile fsOps readdir/lstat/open throw → INTEGRITY_FAILED', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [{ path: 'a.txt', content: 'a' }]);

    const base = await import('node:fs/promises');

    await expectCode(
      () =>
        computeStructureFingerprint(root, {
          fsOps: {
            ...base,
            readdir: async () => {
              throw new Error(`FS_BOOM readdir ${root}`);
            },
          },
        }),
      INTEGRITY_FAILED,
      { leakTokens: [root, 'FS_BOOM'] },
    );

    await expectCode(
      () =>
        computeContentSha256(root, {
          fsOps: {
            ...base,
            lstat: async (p) => {
              throw Object.assign(new Error(`FS_BOOM lstat ${p}`), { code: 'EACCES' });
            },
          },
        }),
      INTEGRITY_FAILED,
      { leakTokens: [root, 'FS_BOOM', 'EACCES'] },
    );

    await expectCode(
      () =>
        computeContentSha256(root, {
          fsOps: {
            ...base,
            open: async () => {
              throw Object.assign(new Error(`FS_BOOM open ${root}`), { code: 'ENOENT' });
            },
          },
        }),
      INTEGRITY_FAILED,
      { leakTokens: [root, 'FS_BOOM', 'ENOENT'] },
    );
  });

  it('outputs are always 64 lowercase hex on success', async () => {
    const root = /** @type {string} */ (rootDir);
    await writeTree(root, [
      { path: 'x', content: Buffer.from([0, 1, 2, 255]) },
    ]);
    const s = await computeStructureFingerprint(root);
    const c = await computeContentSha256(root);
    assert.match(s, HEX64_RE);
    assert.match(c, HEX64_RE);
    assert.equal(s, s.toLowerCase());
    assert.equal(c, c.toLowerCase());
    // Independent sanity: content of single file is not empty digest.
    assert.notEqual(c, EMPTY_CONTENT_SHA);
    // Real crypto still available for local fixture hashing (not fingerprint algo).
    assert.equal(createHash('sha256').update('').digest('hex'), EMPTY_CONTENT_SHA);
  });

  it('computeContentSha256 open flags are numeric and include O_NOFOLLOW', async () => {
    const root = /** @type {string} */ (rootDir);
    // Real ordinary file tree — injection only observes open(path, flags).
    await writeTree(root, [
      { path: 'plain.txt', content: 'nofollow-open-flags' },
      { path: 'nested/other.bin', content: Buffer.from([1, 2, 3, 4]) },
    ]);

    const base = await import('node:fs/promises');
    /** @type {Array<{ path: unknown, flags: unknown }>} */
    const openCalls = [];
    const fsOps = {
      ...base,
      open: async (path, flags, ...rest) => {
        openCalls.push({ path, flags });
        return base.open(path, flags, ...rest);
      },
    };

    const digest = await computeContentSha256(root, { fsOps });
    assert.match(digest, HEX64_RE);
    assert.ok(openCalls.length >= 1, 'expected at least one content open');

    for (const call of openCalls) {
      assert.equal(
        typeof call.flags,
        'number',
        `open flags must be numeric (got ${typeof call.flags}: ${String(call.flags)})`,
      );
      // O_RDONLY may be 0; require O_NOFOLLOW bit set (no string 'r' mode).
      assert.equal(
        (/** @type {number} */ (call.flags) & fsConstants.O_NOFOLLOW) !== 0,
        true,
        `open flags must include O_NOFOLLOW (got ${call.flags})`,
      );
    }
  });
});
