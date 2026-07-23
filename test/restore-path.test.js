import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  assertStrictRelativeTarget,
  assertSnapshotRootRelativeFilePath,
} from '../src/restore-path.js';

const PATH_INVALID = ERROR_CODES.RESTORE_PATH_INVALID;

/**
 * Expect restore-path-invalid LinkeError without echoing path or control bytes.
 * @param {() => unknown} fn
 * @param {{ leakTokens?: string[] }} [opts]
 */
function expectPathInvalid(fn, { leakTokens = [] } = {}) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof LinkeError);
      assert.strictEqual(error.code, PATH_INVALID);
      assert.strictEqual(error.message, PATH_INVALID);
      assert.strictEqual(error.code, 'restore-path-invalid');
      assert.strictEqual(error.message, 'restore-path-invalid');
      const publicParts = [
        error.code,
        error.message,
        error.name,
        String(error.statusCode),
        String(error.retryable),
      ];
      for (const token of leakTokens) {
        if (token === '') continue;
        for (const part of publicParts) {
          assert.ok(!part.includes(token), 'public fields must not echo token');
        }
      }
      // Control bytes must never appear in public message/code.
      const forbiddenControls = ['\0', '\n', '\r', '\x01', '\x7f', '\u0080', '\u009f'];
      for (const control of forbiddenControls) {
        for (const part of publicParts) {
          assert.ok(!part.includes(control), 'public fields must not contain control bytes');
        }
      }
      return true;
    },
  );
}

/** Shared invalid cases for both path APIs (design §§7.6–7.7). */
const REJECT_CASES = [
  { label: 'empty string', value: '', leak: [] },
  { label: 'leading slash', value: '/abs', leak: ['/abs', '/'] },
  { label: 'root only', value: '/', leak: ['/'] },
  { label: 'backslash', value: 'a\\b', leak: ['a\\b', '\\'] },
  { label: 'empty segment //', value: 'a//b', leak: ['a//b'] },
  { label: 'trailing slash', value: 'a/', leak: ['a/'] },
  { label: 'leading empty segment', value: '/a', leak: ['/a'] },
  { label: 'segment .', value: 'a/./b', leak: ['a/./b', '.'] },
  { label: 'segment only .', value: '.', leak: ['.'] },
  { label: 'segment ..', value: 'a/../b', leak: ['a/../b', '..'] },
  { label: 'leading ..', value: '../a', leak: ['../a', '..'] },
  { label: 'leading .', value: './a', leak: ['./a'] },
  { label: 'NUL', value: 'a\0b', leak: ['a\0b', '\0'] },
  { label: 'newline', value: 'a\nb', leak: ['a\nb', '\n'] },
  { label: 'carriage return', value: 'a\rb', leak: ['a\rb', '\r'] },
  { label: 'C0 control TAB', value: 'a\tb', leak: ['a\tb', '\t'] },
  { label: 'C0 control SOH', value: 'a\x01b', leak: ['a\x01b', '\x01'] },
  { label: 'DEL 0x7F', value: 'a\x7fb', leak: ['a\x7fb', '\x7f'] },
  { label: 'C1 control U+0080', value: 'a\u0080b', leak: ['a\u0080b', '\u0080'] },
  { label: 'C1 control U+009F', value: 'a\u009fb', leak: ['a\u009fb', '\u009f'] },
  { label: 'UTF-8 1025 bytes (ascii)', value: 'p'.repeat(1025), leak: ['p'.repeat(32)] },
];

const NON_STRING_VALUES = [
  null,
  undefined,
  0,
  1,
  true,
  false,
  {},
  [],
  () => 'a',
  Symbol('path'),
  12n,
];

function assertAccepts(api, path) {
  assert.strictEqual(api(path), path);
}

function runRejectTable(api) {
  for (const { label, value, leak } of REJECT_CASES) {
    expectPathInvalid(() => api(value), { leakTokens: leak });
  }
  for (const value of NON_STRING_VALUES) {
    expectPathInvalid(() => api(value));
  }
}

describe('assertStrictRelativeTarget', () => {
  it('accepts and returns unchanged strict relative targets', () => {
    for (const path of ['docs/a', 'a', 'a/b/c']) {
      assertAccepts(assertStrictRelativeTarget, path);
    }
  });

  it('rejects empty, absolute, backslash, empty/dot segments, controls, oversize, non-string', () => {
    runRejectTable(assertStrictRelativeTarget);
  });

  it('accepts exact 1024 UTF-8 bytes and rejects 1025 (ascii and multibyte boundary)', () => {
    const exactAscii = 'p'.repeat(1024);
    assert.strictEqual(Buffer.byteLength(exactAscii, 'utf8'), 1024);
    assertAccepts(assertStrictRelativeTarget, exactAscii);

    const overAscii = 'p'.repeat(1025);
    assert.strictEqual(Buffer.byteLength(overAscii, 'utf8'), 1025);
    expectPathInvalid(() => assertStrictRelativeTarget(overAscii), {
      leakTokens: [overAscii.slice(0, 32)],
    });

    // Multibyte: U+4E2D is 3 UTF-8 bytes; 340*3 + 4 = 1024.
    const exactMulti = `${'中'.repeat(340)}abcd`;
    assert.strictEqual(Buffer.byteLength(exactMulti, 'utf8'), 1024);
    assertAccepts(assertStrictRelativeTarget, exactMulti);

    const overMulti = `${'中'.repeat(340)}abcde`;
    assert.strictEqual(Buffer.byteLength(overMulti, 'utf8'), 1025);
    expectPathInvalid(() => assertStrictRelativeTarget(overMulti), {
      leakTokens: ['中', overMulti.slice(0, 8)],
    });
  });
});

describe('assertSnapshotRootRelativeFilePath', () => {
  it('accepts and returns unchanged snapshot-root-relative file paths', () => {
    for (const path of ['docs/a', 'a', 'a/b/c']) {
      assertAccepts(assertSnapshotRootRelativeFilePath, path);
    }
  });

  it('rejects empty, absolute, backslash, empty/dot segments, controls, oversize, non-string', () => {
    runRejectTable(assertSnapshotRootRelativeFilePath);
  });

  it('accepts exact 1024 UTF-8 bytes and rejects 1025 (ascii and multibyte boundary)', () => {
    const exactAscii = 'p'.repeat(1024);
    assert.strictEqual(Buffer.byteLength(exactAscii, 'utf8'), 1024);
    assertAccepts(assertSnapshotRootRelativeFilePath, exactAscii);

    const overAscii = 'p'.repeat(1025);
    assert.strictEqual(Buffer.byteLength(overAscii, 'utf8'), 1025);
    expectPathInvalid(() => assertSnapshotRootRelativeFilePath(overAscii), {
      leakTokens: [overAscii.slice(0, 32)],
    });

    const exactMulti = `${'中'.repeat(340)}abcd`;
    assert.strictEqual(Buffer.byteLength(exactMulti, 'utf8'), 1024);
    assertAccepts(assertSnapshotRootRelativeFilePath, exactMulti);

    const overMulti = `${'中'.repeat(340)}abcde`;
    assert.strictEqual(Buffer.byteLength(overMulti, 'utf8'), 1025);
    expectPathInvalid(() => assertSnapshotRootRelativeFilePath(overMulti), {
      leakTokens: ['中', overMulti.slice(0, 8)],
    });
  });
});
