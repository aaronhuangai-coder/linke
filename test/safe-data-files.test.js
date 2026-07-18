import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SAFE_DATA_FILE_ERROR,
  SafeDataFileError,
  ensureSafeDataRoot,
  ensureSafeRelativeDir,
  normalizeRelativeDataPath,
  safeAppendText,
  safeAtomicWriteBytes,
  safeAtomicWriteText,
  safeCopyFileFromAbsoluteSource,
  safeCreateExclusiveText,
  safeReadBytes,
  safeReadText,
} from '../src/safe-data-files.js';

async function withPair(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-root-`));
  const outside = await mkdtemp(join(tmpdir(), `${prefix}-out-`));
  try {
    await fn(root, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

function assertNoLeak(error, ...needles) {
  const text = [
    error?.name,
    error?.code,
    error?.message,
    error?.stack,
    String(error),
  ].filter(Boolean).join('\n');
  for (const needle of needles) {
    // Skip needles that are substrings of the registered code itself (e.g. ".").
    if (!needle || needle.length < 2) continue;
    if (SAFE_DATA_FILE_ERROR.includes(needle)) continue;
    assert.ok(!text.includes(needle), 'error must not leak path/content');
  }
  assert.ok(
    error instanceof SafeDataFileError
      || error?.code === SAFE_DATA_FILE_ERROR
      || error?.message === SAFE_DATA_FILE_ERROR,
    'must be registered safe error',
  );
  assert.equal(error.message, SAFE_DATA_FILE_ERROR);
}

describe('safe-data-files path validation', () => {
  it('rejects absolute, empty, dot, parent, and NUL relative paths', () => {
    for (const bad of ['', '.', '..', './x', '../x', '/abs', 'a/../b', 'a//b', 'a\0b', 'a/./b']) {
      assert.throws(
        () => normalizeRelativeDataPath(bad),
        (error) => {
          assertNoLeak(error, bad, '/abs');
          return true;
        },
        bad,
      );
    }
    assert.equal(normalizeRelativeDataPath('repo/devices/x'), 'repo/devices/x');
    assert.equal(normalizeRelativeDataPath('device-registry-v1.json'), 'device-registry-v1.json');
  });
});

describe('safe-data-files directory walk', () => {
  it('creates missing components without following a directory symlink', async () => {
    await withPair('safe-dir', async (root, outside) => {
      await symlink(outside, join(root, 'repo'), 'dir');
      await assert.rejects(
        () => ensureSafeRelativeDir(root, 'repo/devices'),
        (error) => {
          assertNoLeak(error, root, outside, 'repo');
          return true;
        },
      );
      const outsideEntries = await readdir(outside);
      assert.equal(outsideEntries.includes('devices'), false);
    });
  });

  it('rejects a non-directory component', async () => {
    await withPair('safe-nondir', async (root) => {
      await writeFile(join(root, 'repo'), 'not-a-dir');
      await assert.rejects(
        () => ensureSafeRelativeDir(root, 'repo/devices'),
        (error) => {
          assertNoLeak(error, root, 'repo');
          return true;
        },
      );
    });
  });
});

describe('safe-data-files read/append/atomic', () => {
  it('reads missing as ENOENT and rejects final file symlink without following', async () => {
    await withPair('safe-read', async (root, outside) => {
      await assert.rejects(
        () => safeReadText(root, 'missing.json'),
        (error) => error && error.code === 'ENOENT',
      );

      const outsideFile = join(outside, 'secret.json');
      await writeFile(outsideFile, '{"secret":true}');
      await symlink(outsideFile, join(root, 'state.json'), 'file');
      await assert.rejects(
        () => safeReadText(root, 'state.json'),
        (error) => {
          assertNoLeak(error, root, outside, 'secret', outsideFile);
          return true;
        },
      );
      assert.equal(await readFile(outsideFile, 'utf8'), '{"secret":true}');
    });
  });

  it('appends with 0600 and rejects final symlink without mutating outside', async () => {
    await withPair('safe-append', async (root, outside) => {
      await safeAppendText(root, 'audit/events.jsonl', '{"ok":1}\n');
      const st = await lstat(join(root, 'audit', 'events.jsonl'));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(await readFile(join(root, 'audit', 'events.jsonl'), 'utf8'), '{"ok":1}\n');

      const outsideFile = join(outside, 'events.jsonl');
      await writeFile(outsideFile, 'OUTSIDE\n');
      await rm(join(root, 'audit'), { recursive: true, force: true });
      await symlink(outside, join(root, 'audit'), 'dir');
      await assert.rejects(
        () => safeAppendText(root, 'audit/events.jsonl', '{"bad":1}\n'),
        (error) => {
          assertNoLeak(error, root, outside, 'OUTSIDE');
          return true;
        },
      );
      assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE\n');
    });
  });

  it('atomic write publishes 0600 regular file and rejects temp/final/dir symlink', async () => {
    await withPair('safe-atomic', async (root, outside) => {
      await safeAtomicWriteText(root, 'device.json', '{"a":1}\n');
      const published = await lstat(join(root, 'device.json'));
      assert.equal(published.isFile(), true);
      assert.equal(published.isSymbolicLink(), false);
      assert.equal(published.mode & 0o777, 0o600);

      const outsideFile = join(outside, 'device.json');
      await writeFile(outsideFile, 'OUTSIDE-FINAL');
      await unlink(join(root, 'device.json'));
      await symlink(outsideFile, join(root, 'device.json'), 'file');
      await assert.rejects(
        () => safeAtomicWriteText(root, 'device.json', '{"x":1}\n'),
        (error) => {
          assertNoLeak(error, root, outside, 'OUTSIDE-FINAL');
          return true;
        },
      );
      assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE-FINAL');

      await unlink(join(root, 'device.json'));
      const outsideTemp = join(outside, 'temp');
      await writeFile(outsideTemp, 'OUTSIDE-TEMP');
      await symlink(outsideTemp, join(root, 'device.json.new'), 'file');
      await assert.rejects(
        () => safeAtomicWriteText(root, 'device.json', '{"y":1}\n', {
          tempRelativePath: 'device.json.new',
        }),
        (error) => {
          assertNoLeak(error, root, outside, 'OUTSIDE-TEMP');
          return true;
        },
      );
      assert.equal(await readFile(outsideTemp, 'utf8'), 'OUTSIDE-TEMP');
    });
  });

  it('supports fixed stale temp overwrite for registry-compatible publish', async () => {
    await withPair('safe-stale-temp', async (root) => {
      await writeFile(join(root, 'device-registry-v1.json.new'), 'stale\n', { mode: 0o644 });
      await safeAtomicWriteText(root, 'device-registry-v1.json', '{"schemaVersion":1}\n', {
        tempRelativePath: 'device-registry-v1.json.new',
        allowExistingTemp: true,
      });
      const published = await lstat(join(root, 'device-registry-v1.json'));
      assert.equal(published.mode & 0o777, 0o600);
      assert.equal(await readFile(join(root, 'device-registry-v1.json'), 'utf8'), '{"schemaVersion":1}\n');
    });
  });

  it('proves O_NOFOLLOW on deterministic check→open final-symlink swap via deps injection', async () => {
    await withPair('safe-race', async (root, outside) => {
      const outsideFile = join(outside, 'swapped');
      await writeFile(outsideFile, 'OUTSIDE-RACE');
      await writeFile(join(root, 'target.json'), 'before');

      let sawTargetLstat = false;
      await assert.rejects(
        () => safeAtomicWriteText(root, 'target.json', '{"swapped":true}\n', {
          deps: {
            lstat: async (path) => {
              const st = await lstat(path);
              // After validating existing regular target, swap it for a symlink before open/rename work.
              if (!sawTargetLstat && path === join(root, 'target.json') && st.isFile()) {
                sawTargetLstat = true;
                await unlink(path);
                await symlink(outsideFile, path, 'file');
                return lstat(path);
              }
              return st;
            },
            open: fsOpen,
            mkdir,
            rename,
            unlink,
          },
        }),
        (error) => {
          assertNoLeak(error, root, outside, 'OUTSIDE-RACE', '{"swapped":true}');
          return true;
        },
      );
      assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE-RACE');
      const finalStat = await lstat(join(root, 'target.json'));
      assert.equal(finalStat.isSymbolicLink(), true);
    });
  });

  it('documents open flags include O_NOFOLLOW for append and exclusive temp create', async () => {
    assert.ok((constants.O_NOFOLLOW | 0) !== 0);
    await withPair('safe-flags', async (root) => {
      const opened = [];
      await safeAppendText(root, 'a.jsonl', 'line\n', {
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            opened.push({ path, flags, mode });
            return fsOpen(path, flags, mode);
          },
          mkdir,
          rename,
          unlink,
        },
      });
      const appendOpen = opened.find((entry) => entry.path.endsWith('a.jsonl'));
      assert.ok(appendOpen);
      assert.equal((appendOpen.flags & constants.O_NOFOLLOW) !== 0, true);
      assert.equal((appendOpen.flags & constants.O_APPEND) !== 0, true);

      opened.length = 0;
      await safeAtomicWriteText(root, 'b.json', 'x\n', {
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            opened.push({ path, flags, mode });
            return fsOpen(path, flags, mode);
          },
          mkdir,
          rename,
          unlink,
        },
      });
      const tempOpen = opened.find((entry) => String(entry.path).includes('.tmp-') || String(entry.path).includes('.new'));
      assert.ok(tempOpen);
      assert.equal((tempOpen.flags & constants.O_NOFOLLOW) !== 0, true);
      assert.equal((tempOpen.flags & constants.O_EXCL) !== 0, true);
    });
  });

  it('safeReadText loops through legitimate short reads and only fails on premature EOF', async () => {
    await withPair('safe-short-read', async (root) => {
      const payload = 'abcdefghij';
      await writeFile(join(root, 'short.json'), payload, { mode: 0o600 });

      let readCalls = 0;
      const text = await safeReadText(root, 'short.json', {
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            const handle = await fsOpen(path, flags, mode);
            const originalRead = handle.read.bind(handle);
            handle.read = async (buffer, offset, length, position) => {
              readCalls += 1;
              // Force short reads of 3 bytes until drained (legitimate partial read).
              const capped = Math.min(3, length);
              return originalRead(buffer, offset, capped, position);
            };
            return handle;
          },
          mkdir,
          rename,
          unlink,
        },
      });
      assert.equal(text, payload);
      assert.ok(readCalls >= 2, 'must loop on short reads');

      // Premature EOF (bytesRead=0 before full size) must fail closed.
      await assert.rejects(
        () => safeReadText(root, 'short.json', {
          deps: {
            lstat,
            open: async (path, flags, mode) => {
              const handle = await fsOpen(path, flags, mode);
              let first = true;
              const originalRead = handle.read.bind(handle);
              const originalStat = handle.stat.bind(handle);
              handle.stat = async () => {
                const st = await originalStat();
                // Report a larger size so a single full read looks like short/EOF.
                return { ...st, size: st.size + 8, isFile: () => true, isSymbolicLink: () => false };
              };
              handle.read = async (buffer, offset, length, position) => {
                if (first) {
                  first = false;
                  return originalRead(buffer, offset, length, position);
                }
                return { bytesRead: 0, buffer };
              };
              return handle;
            },
            mkdir,
            rename,
            unlink,
          },
        }),
        (error) => {
          assertNoLeak(error, root, payload);
          return true;
        },
      );
    });
  });

  it('safeCopyFileFromAbsoluteSource opens source with O_NOFOLLOW and rejects source symlink', async () => {
    await withPair('safe-copy-src', async (root, outside) => {
      const realSrc = join(outside, 'real-src.txt');
      await writeFile(realSrc, 'SOURCE-BYTES');
      const linkSrc = join(outside, 'link-src.txt');
      await symlink(realSrc, linkSrc, 'file');

      const opened = [];
      await safeCopyFileFromAbsoluteSource(root, 'dest/copy.txt', realSrc, {
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            opened.push({ path, flags, mode });
            return fsOpen(path, flags, mode);
          },
          mkdir,
          rename,
          unlink,
        },
      });
      assert.equal(await readFile(join(root, 'dest', 'copy.txt'), 'utf8'), 'SOURCE-BYTES');
      const sourceOpen = opened.find((entry) => entry.path === realSrc);
      assert.ok(sourceOpen);
      assert.equal((sourceOpen.flags & constants.O_NOFOLLOW) !== 0, true);
      assert.equal((sourceOpen.flags & constants.O_RDONLY) !== 0 || sourceOpen.flags === (constants.O_RDONLY | constants.O_NOFOLLOW), true);

      await assert.rejects(
        () => safeCopyFileFromAbsoluteSource(root, 'dest/from-link.txt', linkSrc),
        (error) => {
          assertNoLeak(error, root, outside, 'SOURCE-BYTES', linkSrc);
          return true;
        },
      );
      await assert.rejects(() => readFile(join(root, 'dest', 'from-link.txt')));
    });
  });
});

describe('safeCreateExclusiveText', () => {
  it('creates a new 0600 regular file once and returns created:true with exact content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-ok-'));
    try {
      const result = await safeCreateExclusiveText(root, 'audit/integrity-journal.jsonl', 'LINE-1\n');
      assert.deepEqual(result, { created: true });
      const abs = join(root, 'audit', 'integrity-journal.jsonl');
      const st = await lstat(abs);
      assert.equal(st.isFile(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(await readFile(abs, 'utf8'), 'LINE-1\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns created:false on second create without changing content (no overwrite)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-again-'));
    try {
      await safeCreateExclusiveText(root, 'exclusive.txt', 'ORIGINAL\n');
      const second = await safeCreateExclusiveText(root, 'exclusive.txt', 'REPLACED\n');
      assert.deepEqual(second, { created: false });
      assert.equal(await readFile(join(root, 'exclusive.txt'), 'utf8'), 'ORIGINAL\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows exactly one winner among 10 concurrent exclusive creates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-conc-'));
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          safeCreateExclusiveText(root, 'race.txt', `winner-payload-${index}\n`),
        ),
      );
      const createdTrue = results.filter((r) => r && r.created === true);
      const createdFalse = results.filter((r) => r && r.created === false);
      assert.equal(createdTrue.length, 1);
      assert.equal(createdFalse.length, 9);
      assert.equal(results.length, 10);
      const body = await readFile(join(root, 'race.txt'), 'utf8');
      assert.match(body, /^winner-payload-\d+\n$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates missing parents safely then exclusive-creates the leaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-parent-'));
    try {
      const result = await safeCreateExclusiveText(root, 'a/b/c/journal.jsonl', 'NESTED\n');
      assert.deepEqual(result, { created: true });
      assert.equal(await readFile(join(root, 'a', 'b', 'c', 'journal.jsonl'), 'utf8'), 'NESTED\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns created:false for pre-existing external symlink without mutating outside probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'linke-safe-excl-symlink-out-'));
    try {
      // Dedicated outside probe with known bytes only — never touch sensitive files.
      const probePath = join(outside, 'probe-only.txt');
      const probeBytes = 'PROBE-BYTES-UNCHANGED\n';
      await writeFile(probePath, probeBytes, { mode: 0o600 });
      const before = await lstat(probePath);

      await symlink(probePath, join(root, 'leaf.txt'), 'file');
      const result = await safeCreateExclusiveText(root, 'leaf.txt', 'SHOULD-NOT-WRITE\n');
      assert.deepEqual(result, { created: false });

      const after = await lstat(probePath);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(await readFile(probePath, 'utf8'), probeBytes);
      assert.equal((await lstat(join(root, 'leaf.txt'))).isSymbolicLink(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('returns created:false when leaf path is an existing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-dir-'));
    try {
      await mkdir(join(root, 'as-dir'));
      const result = await safeCreateExclusiveText(root, 'as-dir', 'nope\n');
      assert.deepEqual(result, { created: false });
      const st = await lstat(join(root, 'as-dir'));
      assert.equal(st.isDirectory(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not rename/unlink over an existing regular final file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-norename-'));
    try {
      await writeFile(join(root, 'final.txt'), 'KEEP\n', { mode: 0o600 });
      const renameCalls = [];
      const unlinkCalls = [];
      const result = await safeCreateExclusiveText(root, 'final.txt', 'NEW\n', {
        deps: {
          lstat,
          open: fsOpen,
          mkdir,
          rename: async (...args) => {
            renameCalls.push(args);
            return rename(...args);
          },
          unlink: async (...args) => {
            unlinkCalls.push(args);
            return unlink(...args);
          },
        },
      });
      assert.deepEqual(result, { created: false });
      assert.equal(await readFile(join(root, 'final.txt'), 'utf8'), 'KEEP\n');
      assert.equal(renameCalls.length, 0);
      assert.equal(unlinkCalls.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects non-string text with SafeDataFileError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-text-'));
    try {
      await assert.rejects(
        () => safeCreateExclusiveText(root, 'x.txt', 123),
        (error) => {
          assertNoLeak(error, root, 'x.txt');
          return true;
        },
      );
      await assert.rejects(
        () => safeCreateExclusiveText(root, 'x.txt', null),
        (error) => {
          assertNoLeak(error, root);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('opens final with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW and never renames/unlinks final on success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-flags-'));
    try {
      const opened = [];
      const renameCalls = [];
      const unlinkCalls = [];
      const required =
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

      const result = await safeCreateExclusiveText(root, 'exclusive-flags.txt', 'FLAG\n', {
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            opened.push({ path, flags, mode });
            return fsOpen(path, flags, mode);
          },
          mkdir,
          rename: async (...args) => {
            renameCalls.push(args);
            return rename(...args);
          },
          unlink: async (...args) => {
            unlinkCalls.push(args);
            return unlink(...args);
          },
        },
      });
      assert.deepEqual(result, { created: true });

      const finalOpen = opened.find((entry) => String(entry.path).endsWith('exclusive-flags.txt'));
      assert.ok(finalOpen, 'must open final path directly');
      // Structural flag lock: exact exclusive create mask, not a fragile source includes check.
      assert.equal((finalOpen.flags & required) === required, true);
      assert.equal((finalOpen.flags & constants.O_EXCL) !== 0, true);
      assert.equal((finalOpen.flags & constants.O_NOFOLLOW) !== 0, true);
      assert.equal((finalOpen.flags & constants.O_TRUNC) === 0, true);
      assert.equal((finalOpen.flags & constants.O_APPEND) === 0, true);
      assert.equal(finalOpen.mode, 0o600);
      assert.equal(renameCalls.length, 0);
      assert.equal(unlinkCalls.length, 0);

      // Second create must still report EEXIST path as created:false without rename/unlink.
      opened.length = 0;
      const second = await safeCreateExclusiveText(root, 'exclusive-flags.txt', 'OTHER\n', {
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            opened.push({ path, flags, mode });
            return fsOpen(path, flags, mode);
          },
          mkdir,
          rename: async (...args) => {
            renameCalls.push(args);
            return rename(...args);
          },
          unlink: async (...args) => {
            unlinkCalls.push(args);
            return unlink(...args);
          },
        },
      });
      assert.deepEqual(second, { created: false });
      assert.equal(await readFile(join(root, 'exclusive-flags.txt'), 'utf8'), 'FLAG\n');
      assert.equal(renameCalls.length, 0);
      assert.equal(unlinkCalls.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ensureSafeDataRoot first-create', () => {
  it('accepts existing macOS-style tmp roots without rejecting system /var alias ancestors', async () => {
    await withPair('safe-root-existing', async (root) => {
      // mkdtemp under /var/folders is the common macOS layout; leaf is a real directory.
      const ensured = await ensureSafeDataRoot(root);
      assert.equal(ensured, resolve(root));
      const st = await lstat(root);
      assert.equal(st.isDirectory(), true);
      assert.equal(st.isSymbolicLink(), false);
    });
  });

  it('creates missing nested root segment-by-segment without recursive symlink follow', async () => {
    await withPair('safe-root-create', async (root, outside) => {
      const target = join(root, 'a', 'b', 'data');
      const ensured = await ensureSafeDataRoot(target);
      assert.equal(ensured, resolve(target));
      const st = await lstat(target);
      assert.equal(st.isDirectory(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal((await readdir(outside)).length, 0);
    });
  });

  it('rejects missing root whose direct ancestor is a symlink and creates nothing outside', async () => {
    await withPair('safe-root-direct-link', async (root, outside) => {
      const link = join(root, 'evil');
      await symlink(outside, link, 'dir');
      const target = join(link, 'data');
      await assert.rejects(
        () => ensureSafeDataRoot(target),
        (error) => {
          assertNoLeak(error, root, outside, target, link);
          return true;
        },
      );
      const outsideEntries = await readdir(outside);
      assert.equal(outsideEntries.includes('data'), false);
      assert.equal(outsideEntries.length, 0);
    });
  });

  it('rejects missing root whose intermediate ancestor is a symlink and creates nothing outside', async () => {
    await withPair('safe-root-mid-link', async (root, outside) => {
      const link = join(root, 'mid');
      await symlink(outside, link, 'dir');
      const target = join(link, 'nested', 'data');
      await assert.rejects(
        () => ensureSafeDataRoot(target),
        (error) => {
          assertNoLeak(error, root, outside, target, 'nested');
          return true;
        },
      );
      const outsideEntries = await readdir(outside);
      assert.equal(outsideEntries.includes('nested'), false);
      assert.equal(outsideEntries.includes('data'), false);
      assert.equal(outsideEntries.length, 0);
    });
  });
});

describe('safeReadBytes / safeAtomicWriteBytes', () => {
  it('safeReadBytes returns exact Buffer without UTF-8 decode', async () => {
    await withPair('safe-read-bytes', async (root) => {
      const payload = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x42]);
      await writeFile(join(root, 'raw.bin'), payload, { mode: 0o600 });
      const got = await safeReadBytes(root, 'raw.bin', { maxBytes: 1024 });
      assert.ok(Buffer.isBuffer(got));
      assert.deepEqual(got, payload);
    });
  });

  it('safeReadBytes second fstat rejects append/grow between fstats', async () => {
    await withPair('safe-read-bytes-grow', async (root) => {
      await writeFile(join(root, 'grow.bin'), Buffer.from('abcd'), { mode: 0o600 });
      await assert.rejects(
        () => safeReadBytes(root, 'grow.bin', {
          maxBytes: 1024,
          deps: {
            lstat,
            open: async (path, flags, mode) => {
              const handle = await fsOpen(path, flags, mode);
              const originalStat = handle.stat.bind(handle);
              let statCalls = 0;
              handle.stat = async () => {
                statCalls += 1;
                const st = await originalStat();
                // openRegularNoFollow does 1 stat; safeReadBytes first fstat is #2; mutate on #3.
                if (statCalls < 3) return st;
                return {
                  ...st,
                  size: Number(st.size) + 8,
                  isFile: () => true,
                  isSymbolicLink: () => false,
                };
              };
              return handle;
            },
            mkdir,
            rename,
            unlink,
          },
        }),
        (error) => {
          assertNoLeak(error, root, 'grow.bin');
          return true;
        },
      );
    });
  });

  it('safeReadBytes second fstat rejects truncate between fstats', async () => {
    await withPair('safe-read-bytes-trunc', async (root) => {
      await writeFile(join(root, 'trunc.bin'), Buffer.from('abcdefgh'), { mode: 0o600 });
      await assert.rejects(
        () => safeReadBytes(root, 'trunc.bin', {
          maxBytes: 1024,
          deps: {
            lstat,
            open: async (path, flags, mode) => {
              const handle = await fsOpen(path, flags, mode);
              const originalStat = handle.stat.bind(handle);
              let statCalls = 0;
              handle.stat = async () => {
                statCalls += 1;
                const st = await originalStat();
                // openRegularNoFollow #1; first fstat #2; second fstat #3 mutates.
                if (statCalls < 3) return st;
                return {
                  ...st,
                  size: Math.max(0, Number(st.size) - 3),
                  isFile: () => true,
                  isSymbolicLink: () => false,
                };
              };
              return handle;
            },
            mkdir,
            rename,
            unlink,
          },
        }),
        (error) => {
          assertNoLeak(error, root);
          return true;
        },
      );
    });
  });

  it('safeReadBytes loops short reads and fails premature EOF', async () => {
    await withPair('safe-read-bytes-short', async (root) => {
      const payload = Buffer.from('abcdefghij');
      await writeFile(join(root, 'short.bin'), payload, { mode: 0o600 });
      let readCalls = 0;
      const got = await safeReadBytes(root, 'short.bin', {
        maxBytes: 1024,
        deps: {
          lstat,
          open: async (path, flags, mode) => {
            const handle = await fsOpen(path, flags, mode);
            const originalRead = handle.read.bind(handle);
            handle.read = async (buffer, offset, length, position) => {
              readCalls += 1;
              const capped = Math.min(3, length);
              return originalRead(buffer, offset, capped, position);
            };
            return handle;
          },
          mkdir,
          rename,
          unlink,
        },
      });
      assert.deepEqual(got, payload);
      assert.ok(readCalls >= 2);

      await assert.rejects(
        () => safeReadBytes(root, 'short.bin', {
          maxBytes: 1024,
          deps: {
            lstat,
            open: async (path, flags, mode) => {
              const handle = await fsOpen(path, flags, mode);
              const originalRead = handle.read.bind(handle);
              const originalStat = handle.stat.bind(handle);
              handle.stat = async () => {
                const st = await originalStat();
                return {
                  ...st,
                  size: st.size + 8,
                  isFile: () => true,
                  isSymbolicLink: () => false,
                };
              };
              let first = true;
              handle.read = async (buffer, offset, length, position) => {
                if (first) {
                  first = false;
                  return originalRead(buffer, offset, length, position);
                }
                return { bytesRead: 0, buffer };
              };
              return handle;
            },
            mkdir,
            rename,
            unlink,
          },
        }),
        (error) => {
          assertNoLeak(error, root);
          return true;
        },
      );
    });
  });

  it('safeReadBytes rejects symlink leaf', async () => {
    await withPair('safe-read-bytes-sym', async (root, outside) => {
      const real = join(outside, 'real.bin');
      await writeFile(real, Buffer.from('x'), { mode: 0o600 });
      await symlink(real, join(root, 'link.bin'), 'file');
      await assert.rejects(
        () => safeReadBytes(root, 'link.bin', { maxBytes: 1024 }),
        (error) => {
          assertNoLeak(error, root, outside);
          return true;
        },
      );
    });
  });

  it('safeAtomicWriteBytes publishes Buffer and rejects symlink final leaf', async () => {
    await withPair('safe-write-bytes', async (root, outside) => {
      const payload = Buffer.from([0x01, 0x02, 0xff, 0x00]);
      await safeAtomicWriteBytes(root, 'out.bin', payload, { mode: 0o600 });
      assert.deepEqual(await readFile(join(root, 'out.bin')), payload);
      const st = await lstat(join(root, 'out.bin'));
      assert.equal(st.mode & 0o777, 0o600);

      await symlink(join(outside, 'x'), join(root, 'sym.bin'), 'file');
      await assert.rejects(
        () => safeAtomicWriteBytes(root, 'sym.bin', Buffer.from('nope'), { mode: 0o600 }),
        (error) => {
          assertNoLeak(error, root, outside);
          return true;
        },
      );
    });
  });

  it('safeAtomicWriteBytes snapshots buffer against await TOCTOU mutation', async () => {
    await withPair('safe-write-bytes-snap', async (root) => {
      const buf = Buffer.from('ORIGINAL');
      const original = Buffer.from(buf);
      await safeAtomicWriteBytes(root, 'snap.bin', buf, {
        mode: 0o600,
        deps: {
          lstat,
          mkdir,
          open: async (path, flags, mode) => {
            // Mutate caller buffer after first open await opportunity.
            buf.fill(0x41);
            return fsOpen(path, flags, mode);
          },
          rename,
          unlink,
        },
      });
      assert.deepEqual(await readFile(join(root, 'snap.bin')), original);
    });
  });

  it('safeAtomicWriteBytes kill-before-rename leaves final pre image', async () => {
    await withPair('safe-write-bytes-kill', async (root) => {
      await writeFile(join(root, 'final.bin'), Buffer.from('PRE'), { mode: 0o600 });
      await assert.rejects(
        () => safeAtomicWriteBytes(root, 'final.bin', Buffer.from('POST'), {
          mode: 0o600,
          deps: {
            lstat,
            mkdir,
            open: fsOpen,
            rename: async () => {
              throw new Error('injected-rename-fail');
            },
            unlink,
          },
        }),
        (error) => {
          assertNoLeak(error, root);
          return true;
        },
      );
      assert.deepEqual(await readFile(join(root, 'final.bin')), Buffer.from('PRE'));
    });
  });

  it('safeAtomicWriteBytes kill-after-rename returns SafeDataFileError but final is exact post', async () => {
    await withPair('safe-write-bytes-kill-after', async (root) => {
      await writeFile(join(root, 'final.bin'), Buffer.from('PRE'), { mode: 0o600 });
      const post = Buffer.from('POST-AFTER-RENAME');
      await assert.rejects(
        () => safeAtomicWriteBytes(root, 'final.bin', post, {
          mode: 0o600,
          deps: {
            lstat,
            mkdir,
            open: fsOpen,
            rename: async (...args) => {
              await rename(...args);
              throw new Error('kill-after-rename');
            },
            unlink,
          },
        }),
        (error) => {
          assert.equal(error.name, 'SafeDataFileError');
          assert.equal(error.code, SAFE_DATA_FILE_ERROR);
          assertNoLeak(error, root);
          return true;
        },
      );
      // Rename committed: final must be exact post despite thrown error.
      assert.deepEqual(await readFile(join(root, 'final.bin')), post);
      const again = await safeReadBytes(root, 'final.bin', { maxBytes: 64 });
      assert.equal(
        createHash('sha256').update(again).digest('hex'),
        createHash('sha256').update(post).digest('hex'),
      );
    });
  });
});
