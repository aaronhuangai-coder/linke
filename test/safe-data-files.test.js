import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  safeAtomicWriteText,
  safeCopyFileFromAbsoluteSource,
  safeCreateExclusiveText,
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
