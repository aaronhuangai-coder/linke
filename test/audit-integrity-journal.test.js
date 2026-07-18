/**
 * Tests for unkeyed hash-chain structural consistency foundation (journal init + verify).
 * Success receipts prove journal-internal structure self-consistency only —
 * not authenticity, not cryptographic anti-tamper, and not events provenance.
 * Forbidden capability compound word is never used in this file (Task7 scan contract).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';

const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const DOMAIN_GENERATION_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';
const DOMAIN_EVENT_LINK = 'linke.audit-integrity-journal.v1.event-link\u0000';
const OPEN_RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'recordKind',
  'generationId',
  'sequence',
  'previousLinkDigest',
  'payloadDigest',
  'linkDigest',
]);

/** Independent open-link digest (does not import private helpers from the module under test). */
function independentOpenLinkDigest(generationId) {
  return createHash('sha256')
    .update(DOMAIN_GENERATION_OPEN + generationId + '\u0000' + '0' + '\u0000' + 'null' + '\u0000' + 'null')
    .digest('hex');
}

function independentEventLinkDigest({ generationId, sequence, previousLinkDigest, payloadDigest }) {
  return createHash('sha256')
    .update(
      DOMAIN_EVENT_LINK
        + generationId
        + '\u0000'
        + String(sequence)
        + '\u0000'
        + previousLinkDigest
        + '\u0000'
        + payloadDigest,
    )
    .digest('hex');
}

function expectedOpenLine(generationId) {
  const linkDigest = independentOpenLinkDigest(generationId);
  return JSON.stringify({
    schemaVersion: 1,
    recordKind: 'generation-open',
    generationId,
    sequence: 0,
    previousLinkDigest: null,
    payloadDigest: null,
    linkDigest,
  });
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtempSafe(prefix);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mkdtempSafe(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), `linke-aij-${prefix}-`));
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

async function loadJournalModule() {
  return import('../src/audit-integrity-journal.js');
}

function assertIntegrityError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityJournalError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('EEXIST'));
  assert.ok(!error.message.includes('/var/'));
  assert.ok(!error.message.includes('/private/'));
  return true;
}

describe('audit integrity journal constants and bounds proofs', () => {
  it('exports fixed path/size/line bounds and proves open=240, event max=374, file size≠bounds', async () => {
    const mod = await loadJournalModule();
    assert.equal(mod.AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH, 'audit/integrity-journal.jsonl');
    assert.equal(mod.AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES, 1_572_864);
    assert.equal(mod.AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES, 4096);
    assert.equal(mod.AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND, 4097);
    assert.equal(mod.AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES, 374);

    const openLine = expectedOpenLine(GENERATION_ID);
    assert.equal(Buffer.byteLength(openLine, 'utf8'), 240);

    const hex64 = 'a'.repeat(64);
    const maxEventLine = JSON.stringify({
      schemaVersion: 1,
      recordKind: 'event-link',
      generationId: GENERATION_ID,
      sequence: Number.MAX_SAFE_INTEGER,
      previousLinkDigest: hex64,
      payloadDigest: hex64,
      linkDigest: hex64,
    });
    assert.equal(Buffer.byteLength(maxEventLine, 'utf8'), 374);

    // Legitimate API max lines (with trailing newline each) stay under pre-read size.
    assert.ok(4096 * 375 < mod.AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES);
    assert.ok(4097 * 375 < mod.AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES);
    // size overlimit is io-error, never bounds-exceeded (asserted in separate io test).
    assert.notEqual(
      ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR,
      ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED,
    );
  });
});

describe('initializeAuditIntegrityJournal', () => {
  it('returns initialized receipt with independently recomputed open headDigest', async () => {
    await withTempRoot('init-ok', async (root) => {
      const {
        initializeAuditIntegrityJournal,
      } = await loadJournalModule();
      const expectedHead = independentOpenLinkDigest(GENERATION_ID);
      const receipt = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      assert.deepEqual(receipt, {
        state: 'initialized',
        generationId: GENERATION_ID,
        recordCount: 1,
        headDigest: expectedHead,
      });
      assert.equal(Object.keys(receipt).join(','), 'state,generationId,recordCount,headDigest');
    });
  });

  it('writes exact key-order generation-open line of 240 UTF-8 bytes with mode 0600 regular file', async () => {
    await withTempRoot('init-bytes', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const abs = journalAbs(root);
      const raw = await readFile(abs, 'utf8');
      const expectedLine = expectedOpenLine(GENERATION_ID);
      assert.equal(raw, `${expectedLine}\n`);
      assert.equal(Buffer.byteLength(expectedLine, 'utf8'), 240);
      const parsed = JSON.parse(expectedLine);
      assert.deepEqual(Object.keys(parsed), [...OPEN_RECORD_KEYS]);
      const st = await lstat(abs);
      assert.equal(st.isFile(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  it('duplicate initialize throws already-initialized and leaves bytes unchanged', async () => {
    await withTempRoot('init-dup', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        (error) => assertIntegrityError(
          error,
          ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED,
          root,
        ),
      );
      const after = await readFile(journalAbs(root));
      assert.deepEqual(after, before);
    });
  });

  it('concurrent initialize x8 yields exactly one success and seven already-initialized', async () => {
    await withTempRoot('init-race', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 7);
      assert.equal(fulfilled[0].value.state, 'initialized');
      for (const r of rejected) {
        assertIntegrityError(
          r.reason,
          ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED,
          root,
        );
      }
      const raw = await readFile(journalAbs(root), 'utf8');
      assert.equal(raw, `${expectedOpenLine(GENERATION_ID)}\n`);
    });
  });

  it('final leaf symlink outside probe maps to already-initialized without mutating outside', async () => {
    const root = await mkdtempSafe('init-symlink-root');
    const outside = await mkdtempSafe('init-symlink-out');
    try {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const probePath = join(outside, 'probe-only.txt');
      const probeBytes = 'PROBE-BYTES-UNCHANGED\n';
      await writeFile(probePath, probeBytes, { mode: 0o600 });
      const before = await lstat(probePath);
      const beforeBytes = await readFile(probePath);

      await mkdir(join(root, 'audit'), { recursive: true });
      await symlink(probePath, journalAbs(root), 'file');

      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          return true;
        },
      );

      const after = await lstat(probePath);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.deepEqual(await readFile(probePath), beforeBytes);
      assert.equal(await readFile(probePath, 'utf8'), probeBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('directory or malicious leaf at journal path maps to already-initialized not io-error', async () => {
    await withTempRoot('init-dir-leaf', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      // Directory leaf occupying the journal relative path.
      await mkdir(journalAbs(root), { recursive: true });
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          return true;
        },
      );
    });

    await withTempRoot('init-malicious-leaf', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      // Non-regular-ish placeholder: empty regular file still EEXIST → already-initialized.
      await writeFile(journalAbs(root), 'placeholder-not-a-chain\n', { mode: 0o600 });
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          return true;
        },
      );
    });
  });

  it('bad generationId matrix throws generation-id-invalid with path-free message===code', async () => {
    await withTempRoot('init-bad-gen', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const bad = [
        '',
        '0123456789ABCDEF0123456789abcdef', // uppercase
        '0123456789abcdef0123456789abcde', // 31
        '0123456789abcdef0123456789abcdef0', // 33
        'gggggggggggggggggggggggggggggggg',
        null,
        undefined,
        123,
        { generationId: GENERATION_ID },
      ];
      for (const generationId of bad) {
        await assert.rejects(
          () => initializeAuditIntegrityJournal(root, { generationId }),
          (error) => assertIntegrityError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID,
            root,
          ),
        );
      }
    });
  });

  it('hostile generationId getter throw maps to generation-id-invalid without SECRET leak', async () => {
    await withTempRoot('init-hostile-getter', async (root) => {
      const { initializeAuditIntegrityJournal, AuditIntegrityJournalError } =
        await loadJournalModule();
      const options = Object.defineProperty({}, 'generationId', {
        get() {
          throw new Error('SECRET-GETTER');
        },
      });
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, options),
        (error) => {
          assert.ok(error instanceof AuditIntegrityJournalError);
          assertIntegrityError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID,
            root,
          );
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          assert.ok(!error.message.includes('SECRET'));
          assert.ok(!String(error.stack || '').split('\n')[0].includes('SECRET'));
          assert.ok(!error.message.includes('SECRET-GETTER'));
          return true;
        },
      );
    });
  });

  it('hostile generationId Proxy get trap maps to generation-id-invalid without SECRET leak', async () => {
    await withTempRoot('init-hostile-proxy', async (root) => {
      const { initializeAuditIntegrityJournal, AuditIntegrityJournalError } =
        await loadJournalModule();
      const options = new Proxy({}, {
        get() {
          throw new Error('SECRET-PROXY');
        },
      });
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, options),
        (error) => {
          assert.ok(error instanceof AuditIntegrityJournalError);
          assertIntegrityError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID,
            root,
          );
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          assert.ok(!error.message.includes('SECRET'));
          assert.ok(!String(error.stack || '').split('\n')[0].includes('SECRET'));
          assert.ok(!error.message.includes('SECRET-PROXY'));
          return true;
        },
      );
    });
  });
});

describe('verifyAuditIntegrityJournalFile', () => {
  it('missing journal throws not-initialized', async () => {
    await withTempRoot('verify-missing', async (root) => {
      const { verifyAuditIntegrityJournalFile } = await loadJournalModule();
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(
          error,
          ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED,
          root,
        ),
      );
    });
  });

  it('verify after initialize returns exact verified receipt matching gen/head/count', async () => {
    await withTempRoot('verify-ok', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.deepEqual(verified, {
        state: 'verified',
        generationId: init.generationId,
        recordCount: init.recordCount,
        headDigest: init.headDigest,
      });
      assert.equal(Object.keys(verified).join(','), 'state,generationId,recordCount,headDigest');
      // Structural self-consistency only — not authenticity / events binding.
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 1);
    });
  });

  it('missing final newline is chain-broken and leaves bytes unchanged', async () => {
    await withTempRoot('verify-no-nl', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const abs = journalAbs(root);
      const good = await readFile(abs, 'utf8');
      assert.ok(good.endsWith('\n'));
      const truncated = good.slice(0, -1);
      await writeFile(abs, truncated, { mode: 0o600 });
      const before = await readFile(abs);
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      assert.deepEqual(await readFile(abs), before);
    });
  });

  it('mutating linkDigest one nibble without recompute yields chain-broken', async () => {
    await withTempRoot('verify-nibble', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const abs = journalAbs(root);
      const raw = await readFile(abs, 'utf8');
      const line = raw.slice(0, -1);
      const obj = JSON.parse(line);
      const original = obj.linkDigest;
      const flipped = (original[0] === '0' ? '1' : '0') + original.slice(1);
      obj.linkDigest = flipped;
      // Keep exact key order when re-stringifying.
      const mutated = JSON.stringify({
        schemaVersion: obj.schemaVersion,
        recordKind: obj.recordKind,
        generationId: obj.generationId,
        sequence: obj.sequence,
        previousLinkDigest: obj.previousLinkDigest,
        payloadDigest: obj.payloadDigest,
        linkDigest: obj.linkDigest,
      });
      await writeFile(abs, `${mutated}\n`, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
    });
  });

  it('public error message/name/code are path-free and omit temp root and errno text', async () => {
    await withTempRoot('err-path-free', async (root) => {
      const { verifyAuditIntegrityJournalFile, initializeAuditIntegrityJournal } =
        await loadJournalModule();
      try {
        await verifyAuditIntegrityJournalFile(root);
        assert.fail('expected throw');
      } catch (error) {
        assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED, root);
        assert.ok(!JSON.stringify(error).includes(root));
      }
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await writeFile(journalAbs(root), '{\n', { mode: 0o600 });
      try {
        await verifyAuditIntegrityJournalFile(root);
        assert.fail('expected throw');
      } catch (error) {
        assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root);
        assert.ok(!error.message.includes('Unexpected'));
        assert.ok(!error.message.includes(root));
      }
    });
  });

  it('invalid root and pre-read size over limit map to io-error not bounds', async () => {
    const {
      verifyAuditIntegrityJournalFile,
      initializeAuditIntegrityJournal,
      AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
    } = await loadJournalModule();

    await assert.rejects(
      () => verifyAuditIntegrityJournalFile('/no/such/linke-aij-root-' + Date.now()),
      (error) => {
        assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
        assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
        assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
        return true;
      },
    );

    await withTempRoot('verify-size-io', async (root) => {
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const oversize = 'x'.repeat(AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES + 1);
      // Oversized file: safeReadText size gate → io-error (never bounds).
      await writeFile(journalAbs(root), `${oversize}\n`, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
          return true;
        },
      );
    });
  });

  it('line-count 4098 and single 375-byte line hit bounds-exceeded before structural parse', async () => {
    await withTempRoot('verify-bounds-lines', async (root) => {
      const { verifyAuditIntegrityJournalFile } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      // 4098 non-empty short lines with trailing newline → line-count bounds (not chain).
      const many = `${'x\n'.repeat(4098)}`;
      await writeFile(journalAbs(root), many, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          return true;
        },
      );
    });

    await withTempRoot('verify-bounds-line-bytes', async (root) => {
      const { verifyAuditIntegrityJournalFile } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      // 375 UTF-8 bytes on a single line — bounds before JSON.parse.
      const hugeLine = `${'a'.repeat(375)}\n`;
      assert.equal(Buffer.byteLength(hugeLine.slice(0, -1), 'utf8'), 375);
      await writeFile(journalAbs(root), hugeLine, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          return true;
        },
      );
    });
  });

  it('bad JSON, wrong key order, extra key, uppercase hex, and seq constraint are chain-broken', async () => {
    await withTempRoot('verify-chain-matrix', async (root) => {
      const { verifyAuditIntegrityJournalFile } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      const abs = journalAbs(root);
      const head = independentOpenLinkDigest(GENERATION_ID);

      const cases = [
        'not-json\n',
        // wrong key order (recordKind before schemaVersion)
        `${JSON.stringify({
          recordKind: 'generation-open',
          schemaVersion: 1,
          generationId: GENERATION_ID,
          sequence: 0,
          previousLinkDigest: null,
          payloadDigest: null,
          linkDigest: head,
        })}\n`,
        // extra key
        `${JSON.stringify({
          schemaVersion: 1,
          recordKind: 'generation-open',
          generationId: GENERATION_ID,
          sequence: 0,
          previousLinkDigest: null,
          payloadDigest: null,
          linkDigest: head,
          extra: true,
        })}\n`,
        // uppercase hex generationId
        `${JSON.stringify({
          schemaVersion: 1,
          recordKind: 'generation-open',
          generationId: GENERATION_ID.toUpperCase(),
          sequence: 0,
          previousLinkDigest: null,
          payloadDigest: null,
          linkDigest: head,
        })}\n`,
        // open sequence must be 0
        `${JSON.stringify({
          schemaVersion: 1,
          recordKind: 'generation-open',
          generationId: GENERATION_ID,
          sequence: 1,
          previousLinkDigest: null,
          payloadDigest: null,
          linkDigest: head,
        })}\n`,
      ];

      for (const raw of cases) {
        await writeFile(abs, raw, { mode: 0o600 });
        await assert.rejects(
          () => verifyAuditIntegrityJournalFile(root),
          (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
        );
      }
    });
  });

  it('success is structural only: module does not import audit-log or production events wiring; payload not cross-checked', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const sourcePath = new URL('../src/audit-integrity-journal.js', import.meta.url);
    const source = await rf(sourcePath, 'utf8');
    // Ban production audit-log / server / events append wiring only.
    // Task5 may legally import ./audit-event-schema.js — do not ban that path.
    assert.ok(!source.includes("from './audit-log.js'"));
    assert.ok(!source.includes('from "./audit-log.js"'));
    assert.ok(!source.includes("from './server.js'"));
    assert.ok(!source.includes('from "./server.js"'));
    assert.ok(!/import\s+[^;]*events\.jsonl/.test(source));
    assert.ok(!source.includes('appendAuditEvent'));
    // Must not export append in this C2 slice.
    assert.ok(!source.includes('export async function appendAuditIntegrityEvent'));
    assert.ok(!source.includes('export function appendAuditIntegrityEvent'));

    await withTempRoot('verify-structural-only', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const verified = await verifyAuditIntegrityJournalFile(root);
      // Receipt proves internal structure self-consistency only.
      assert.equal(verified.state, 'verified');
      assert.equal(verified.headDigest, init.headDigest);
      assert.equal(verified.generationId, init.generationId);
      // payloadDigest on open is null by schema; verify does not consult events store.
      const line = (await readFile(journalAbs(root), 'utf8')).trimEnd();
      const record = JSON.parse(line);
      assert.equal(record.payloadDigest, null);
    });
  });

  it('hand-built open + event-link chain verifies with independent event-link digest; payload is record hex only', async () => {
    await withTempRoot('verify-event-link', async (root) => {
      const { verifyAuditIntegrityJournalFile } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });

      const openLink = independentOpenLinkDigest(GENERATION_ID);
      // Fixed 64hex payloadDigest used only as journal-record link input (not from events store).
      const payloadDigest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const eventLink = independentEventLinkDigest({
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: openLink,
        payloadDigest,
      });

      const openLine = JSON.stringify({
        schemaVersion: 1,
        recordKind: 'generation-open',
        generationId: GENERATION_ID,
        sequence: 0,
        previousLinkDigest: null,
        payloadDigest: null,
        linkDigest: openLink,
      });
      const eventLine = JSON.stringify({
        schemaVersion: 1,
        recordKind: 'event-link',
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: openLink,
        payloadDigest,
        linkDigest: eventLink,
      });
      assert.deepEqual(Object.keys(JSON.parse(openLine)), [...OPEN_RECORD_KEYS]);
      assert.deepEqual(Object.keys(JSON.parse(eventLine)), [...OPEN_RECORD_KEYS]);

      const abs = journalAbs(root);
      await writeFile(abs, `${openLine}\n${eventLine}\n`, { mode: 0o600 });

      // No external events path is created; payloadDigest hex lives only inside the journal record.
      const { access } = await import('node:fs/promises');
      await assert.rejects(() => access(join(root, 'audit', 'events.jsonl')), { code: 'ENOENT' });

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.deepEqual(verified, {
        state: 'verified',
        generationId: GENERATION_ID,
        recordCount: 2,
        headDigest: eventLink,
      });
      assert.equal(Object.keys(verified).join(','), 'state,generationId,recordCount,headDigest');

      // Re-read: event payloadDigest is the same fixed hex used as link input; no events store lookup.
      const raw = await readFile(abs, 'utf8');
      const eventRecord = JSON.parse(raw.trimEnd().split('\n')[1]);
      assert.equal(eventRecord.payloadDigest, payloadDigest);
      assert.equal(eventRecord.previousLinkDigest, openLink);
      assert.equal(eventRecord.linkDigest, eventLink);
      assert.equal(
        independentEventLinkDigest({
          generationId: eventRecord.generationId,
          sequence: eventRecord.sequence,
          previousLinkDigest: eventRecord.previousLinkDigest,
          payloadDigest: eventRecord.payloadDigest,
        }),
        eventRecord.linkDigest,
      );
    });
  });
});

describe('auditIntegrityJournalQueues source contract', () => {
  it('uses a single auditIntegrityJournalQueues Map and enqueues initialize; no append/server/audit-log import', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const sourcePath = new URL('../src/audit-integrity-journal.js', import.meta.url);
    const source = await rf(sourcePath, 'utf8');

    const mapDecls = source.match(/auditIntegrityJournalQueues\s*=\s*new Map\s*\(\s*\)/g) || [];
    assert.equal(mapDecls.length, 1, 'exactly one auditIntegrityJournalQueues Map');
    assert.ok(source.includes('auditIntegrityJournalQueues.get'));
    assert.ok(source.includes('auditIntegrityJournalQueues.set'));
    // initialize body must touch the queue (enqueue pattern).
    assert.ok(
      /previous\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(source)
        || /previous\.catch\(\(\)=>\{\}\)/.test(source)
        || source.includes('previous.catch(() => {})'),
    );
    assert.ok(!source.includes("from './audit-log.js'"));
    assert.ok(!source.includes("from './server.js'"));
    assert.ok(!source.includes("from '../server.js'"));
    // No append export yet (Task5).
    assert.match(source, /const auditIntegrityJournalQueues = new Map\(\)/);

    // Runtime: concurrent init uses queue + O_EXCL (covered by race test); here re-check module loads.
    const mod = await loadJournalModule();
    assert.equal(typeof mod.initializeAuditIntegrityJournal, 'function');
    assert.equal(typeof mod.verifyAuditIntegrityJournalFile, 'function');
    assert.equal(typeof mod.appendAuditIntegrityEvent, 'undefined');
  });
});
