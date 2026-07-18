/**
 * Tests for unkeyed hash-chain structural consistency foundation
 * (journal init + verify + append + honest limitations).
 * Success receipts prove journal-internal structure self-consistency only —
 * not authenticity, not cryptographic anti-tamper, and not events provenance.
 * Forbidden capability compound word is never used in this file (Task7 scan contract).
 * Honest limitation cases must PASS with verify success (design §2.4 / §17).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import { stringifyStrictCanonicalSanitizedEvent } from '../src/audit-event-schema.js';

const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const GENERATION_ID_ALT = 'fedcba9876543210fedcba9876543210';
const DOMAIN_GENERATION_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';
const DOMAIN_EVENT_PAYLOAD = 'linke.audit-integrity-journal.v1.event-payload\u0000';
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

/** Fixed strict-canonical event vector (stable id/createdAt for digests). */
const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

const EVENT_B = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-07-18T00:00:01.000Z',
  type: 'api.test',
  method: 'GET',
  path: '/api/other',
  outcome: 'success',
});

/** Independent open-link digest (does not import private helpers from the module under test). */
function independentOpenLinkDigest(generationId) {
  return createHash('sha256')
    .update(DOMAIN_GENERATION_OPEN + generationId + '\u0000' + '0' + '\u0000' + 'null' + '\u0000' + 'null')
    .digest('hex');
}

/**
 * Independent write-time payloadDigest: DOMAIN_EVENT_PAYLOAD + strict stringify UTF-8.
 * Verify does NOT recompute this against events; tests recompute only to assert write-time receipt.
 */
function independentPayloadDigest(event) {
  const canonical = stringifyStrictCanonicalSanitizedEvent(event);
  return createHash('sha256')
    .update(DOMAIN_EVENT_PAYLOAD + canonical)
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

function canonicalRecordLine(record) {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    recordKind: record.recordKind,
    generationId: record.generationId,
    sequence: record.sequence,
    previousLinkDigest: record.previousLinkDigest,
    payloadDigest: record.payloadDigest,
    linkDigest: record.linkDigest,
  });
}

function expectedOpenLine(generationId) {
  const linkDigest = independentOpenLinkDigest(generationId);
  return canonicalRecordLine({
    schemaVersion: 1,
    recordKind: 'generation-open',
    generationId,
    sequence: 0,
    previousLinkDigest: null,
    payloadDigest: null,
    linkDigest,
  });
}

/**
 * Build a legal journal with 1 open + eventLinkCount event-link rows (exact 7-key order).
 * Uses independent SHA256 for each payload hex — never imports private journal digests.
 * For existing===4096: eventLinkCount=4095 (open counts as record #1).
 */
function buildLegalJournalRaw(generationId, eventLinkCount) {
  const lines = [];
  let prev = independentOpenLinkDigest(generationId);
  lines.push(canonicalRecordLine({
    schemaVersion: 1,
    recordKind: 'generation-open',
    generationId,
    sequence: 0,
    previousLinkDigest: null,
    payloadDigest: null,
    linkDigest: prev,
  }));
  for (let seq = 1; seq <= eventLinkCount; seq += 1) {
    // Varying but legal 64-hex payload; independent of implementation digests.
    const payloadDigest = createHash('sha256')
      .update(`fixture-payload:${generationId}:${seq}`)
      .digest('hex');
    const linkDigest = independentEventLinkDigest({
      generationId,
      sequence: seq,
      previousLinkDigest: prev,
      payloadDigest,
    });
    const line = canonicalRecordLine({
      schemaVersion: 1,
      recordKind: 'event-link',
      generationId,
      sequence: seq,
      previousLinkDigest: prev,
      payloadDigest,
      linkDigest,
    });
    assert.ok(
      Buffer.byteLength(line, 'utf8') <= 374,
      `fixture line ${seq} exceeds per-line bound`,
    );
    lines.push(line);
    prev = linkDigest;
  }
  const raw = `${lines.join('\n')}\n`;
  assert.ok(
    Buffer.byteLength(raw, 'utf8') <= 1_572_864,
    'fixture exceeds pre-read maxBytes',
  );
  return { raw, headDigest: prev, recordCount: lines.length };
}

async function writeJournalRaw(root, raw) {
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(journalAbs(root), raw, { mode: 0o600 });
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

  it('success is structural only: no audit-log/server/events wiring; payload not cross-checked', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const sourcePath = new URL('../src/audit-integrity-journal.js', import.meta.url);
    const source = await rf(sourcePath, 'utf8');
    // Ban production audit-log / server / events append wiring only.
    // C3 requires schema import + append export — do not ban those.
    assert.ok(!source.includes("from './audit-log.js'"));
    assert.ok(!source.includes('from "./audit-log.js"'));
    assert.ok(!source.includes("from './server.js'"));
    assert.ok(!source.includes('from "./server.js"'));
    assert.ok(!/import\s+[^;]*events\.jsonl/.test(source));
    assert.ok(!source.includes('appendAuditEvent'));
    assert.ok(
      source.includes("from './audit-event-schema.js'")
        || source.includes('from "./audit-event-schema.js"'),
    );
    assert.ok(source.includes('export async function appendAuditIntegrityEvent'));

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
  it('C3: exactly one queue Map; init+append both enqueue same helper; schema import; ban audit-log/server/events wiring', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const sourcePath = new URL('../src/audit-integrity-journal.js', import.meta.url);
    const source = await rf(sourcePath, 'utf8');

    const mapDecls = source.match(/auditIntegrityJournalQueues\s*=\s*new Map\s*\(\s*\)/g) || [];
    assert.equal(mapDecls.length, 1, 'exactly one auditIntegrityJournalQueues Map');
    assert.match(source, /const auditIntegrityJournalQueues = new Map\(\)/);
    // Forbidden: second Maps / split queues.
    assert.ok(!source.includes('appendQueues'));
    assert.ok(!source.includes('initQueues'));
    assert.equal((source.match(/new Map\s*\(\s*\)/g) || []).length, 1);

    // Single enqueue helper; init and append both call it (definition + ≥2 call sites).
    assert.ok(source.includes('function enqueueAuditIntegrityJournalTask'));
    const callSites = [...source.matchAll(/\benqueueAuditIntegrityJournalTask\s*\(/g)];
    assert.ok(callSites.length >= 2, `expected ≥2 enqueue call sites, got ${callSites.length}`);
    assert.ok(source.includes('export async function initializeAuditIntegrityJournal'));
    assert.ok(source.includes('export async function appendAuditIntegrityEvent'));
    // Both writers return enqueueAuditIntegrityJournalTask(...).
    const returnEnqueue = source.match(/return enqueueAuditIntegrityJournalTask\s*\(/g) || [];
    assert.ok(returnEnqueue.length >= 2, 'init and append must both return enqueue helper');

    assert.ok(
      source.includes("from './audit-event-schema.js'")
        || source.includes('from "./audit-event-schema.js"'),
      'C3 requires schema import for strict stringify',
    );
    assert.ok(source.includes('stringifyStrictCanonicalSanitizedEvent'));
    assert.ok(source.includes('safeAppendText'));

    assert.ok(!source.includes("from './audit-log.js'"));
    assert.ok(!source.includes("from './server.js'"));
    assert.ok(!source.includes("from '../server.js'"));
    assert.ok(!source.includes('appendAuditEvent'));
    // Ban production events path wiring / dual-write — honest limitation comments may mention events.jsonl.
    assert.ok(!/from\s+['"][^'"]*events\.jsonl['"]/.test(source));
    assert.ok(!source.includes("safeAppendText(resolvedRoot, 'audit/events.jsonl'"));
    assert.ok(!source.includes('AUDIT_EVENTS'));
    assert.ok(!source.includes("relativePath: 'audit/events.jsonl'"));

    assert.ok(
      /previous\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(source)
        || /previous\.catch\(\(\)=>\{\}\)/.test(source)
        || source.includes('previous.catch(() => {})'),
    );

    const mod = await loadJournalModule();
    assert.equal(typeof mod.initializeAuditIntegrityJournal, 'function');
    assert.equal(typeof mod.verifyAuditIntegrityJournalFile, 'function');
    assert.equal(typeof mod.appendAuditIntegrityEvent, 'function');
  });
});

describe('appendAuditIntegrityEvent', () => {
  it('1: uninit append → not-initialized and journal file still absent', async () => {
    await withTempRoot('append-uninit', async (root) => {
      const { appendAuditIntegrityEvent } = await loadJournalModule();
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } }),
        (error) => assertIntegrityError(
          error,
          ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED,
          root,
        ),
      );
      const { access } = await import('node:fs/promises');
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
    });
  });

  it('2: first append exact receipt seq1/count2; independent payload/head; exact line order', async () => {
    await withTempRoot('append-first', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const expectedPayload = independentPayloadDigest(EVENT_A);
      const expectedLink = independentEventLinkDigest({
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: init.headDigest,
        payloadDigest: expectedPayload,
      });
      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.deepEqual(receipt, {
        state: 'appended',
        generationId: GENERATION_ID,
        sequence: 1,
        recordCount: 2,
        headDigest: expectedLink,
        payloadDigest: expectedPayload,
      });
      assert.equal(
        Object.keys(receipt).join(','),
        'state,generationId,sequence,recordCount,headDigest,payloadDigest',
      );

      const raw = await readFile(journalAbs(root), 'utf8');
      const lines = raw.slice(0, -1).split('\n');
      assert.equal(lines.length, 2);
      assert.equal(lines[0], expectedOpenLine(GENERATION_ID));
      const eventRecord = JSON.parse(lines[1]);
      assert.deepEqual(Object.keys(eventRecord), [...OPEN_RECORD_KEYS]);
      assert.equal(eventRecord.recordKind, 'event-link');
      assert.equal(eventRecord.sequence, 1);
      assert.equal(eventRecord.previousLinkDigest, init.headDigest);
      assert.equal(eventRecord.payloadDigest, expectedPayload);
      assert.equal(eventRecord.linkDigest, expectedLink);
      assert.equal(lines[1], canonicalRecordLine(eventRecord));
      // Journal line holds digests only — not event raw body fields as free text payload.
      assert.ok(!lines[1].includes(EVENT_A.id));
      assert.ok(!lines[1].includes('/api/test'));
    });
  });

  it('3: second event sequence 2 with previousLinkDigest chain', async () => {
    await withTempRoot('append-second', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const first = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const expectedPayloadB = independentPayloadDigest(EVENT_B);
      const expectedLinkB = independentEventLinkDigest({
        generationId: GENERATION_ID,
        sequence: 2,
        previousLinkDigest: first.headDigest,
        payloadDigest: expectedPayloadB,
      });
      const second = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      assert.equal(second.state, 'appended');
      assert.equal(second.sequence, 2);
      assert.equal(second.recordCount, 3);
      assert.equal(second.payloadDigest, expectedPayloadB);
      assert.equal(second.headDigest, expectedLinkB);

      const lines = (await readFile(journalAbs(root), 'utf8')).slice(0, -1).split('\n');
      const rec2 = JSON.parse(lines[2]);
      assert.equal(rec2.sequence, 2);
      assert.equal(rec2.previousLinkDigest, first.headDigest);
      assert.equal(rec2.linkDigest, expectedLinkB);
    });
  });

  it('4: public verify after append returns exact structural success', async () => {
    await withTempRoot('append-verify', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const appended = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.deepEqual(verified, {
        state: 'verified',
        generationId: GENERATION_ID,
        recordCount: 2,
        headDigest: appended.headDigest,
      });
      assert.equal(Object.keys(verified).join(','), 'state,generationId,recordCount,headDigest');
    });
  });

  it('5: caller sequence/previous/options extras ignored; throwing getters on extras never read', async () => {
    await withTempRoot('append-ignore-extras', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      let seqGets = 0;
      let prevGets = 0;
      const options = {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
        sequence: 99,
        previousLinkDigest: 'c'.repeat(64),
        get bogus() {
          throw new Error('SHOULD-NOT-READ-BOGUS');
        },
      };
      Object.defineProperty(options, 'sequence', {
        enumerable: true,
        get() {
          seqGets += 1;
          throw new Error('SHOULD-NOT-READ-SEQUENCE');
        },
      });
      Object.defineProperty(options, 'previousLinkDigest', {
        enumerable: true,
        get() {
          prevGets += 1;
          throw new Error('SHOULD-NOT-READ-PREV');
        },
      });

      const expectedPayload = independentPayloadDigest(EVENT_A);
      const expectedLink = independentEventLinkDigest({
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: init.headDigest,
        payloadDigest: expectedPayload,
      });
      const receipt = await appendAuditIntegrityEvent(root, options);
      assert.equal(receipt.sequence, 1);
      assert.equal(receipt.headDigest, expectedLink);
      assert.equal(seqGets, 0, 'sequence getter must not be read');
      assert.equal(prevGets, 0, 'previousLinkDigest getter must not be read');
    });
  });

  it('6: missing id or createdAt → event-invalid; bytes unchanged', async () => {
    await withTempRoot('append-missing-fields', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { createdAt: EVENT_A.createdAt, type: 'x' },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { id: EVENT_A.id, type: 'x' },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
    });
  });

  it('7: Proxy/accessor event → event-invalid; SECRET not leaked; bytes unchanged', async () => {
    await withTempRoot('append-hostile-event', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        AuditIntegrityJournalError,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));

      const proxyEvent = new Proxy({ ...EVENT_A }, {
        get() {
          throw new Error('SECRET-EVENT-PROXY');
        },
      });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: proxyEvent }),
        (error) => {
          assert.ok(error instanceof AuditIntegrityJournalError);
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID, root);
          assert.ok(!error.message.includes('SECRET'));
          assert.ok(!String(error.stack || '').split('\n')[0].includes('SECRET'));
          return true;
        },
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);

      const accessorEvent = {};
      Object.defineProperty(accessorEvent, 'id', {
        enumerable: true,
        get() {
          return 'SECRET-ACCESSOR-ID';
        },
      });
      Object.defineProperty(accessorEvent, 'createdAt', {
        enumerable: true,
        value: EVENT_A.createdAt,
        writable: true,
      });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: accessorEvent,
        }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID, root);
          assert.ok(!error.message.includes('SECRET'));
          return true;
        },
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
    });
  });

  it('8: extra key or noncanonical createdAt → event-invalid', async () => {
    await withTempRoot('append-extra-noncanon', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A, extra: 'nope' },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID, root),
      );

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          // missing milliseconds — sanitize would rewrite; strict rejects
          event: { ...EVENT_A, createdAt: '2026-07-18T00:00:00Z' },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
    });
  });

  it('9: concurrent 20 appends all succeed; final count 21; seq 1..20 continuous; verify ok', async () => {
    await withTempRoot('append-x20', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const events = Array.from({ length: 20 }, (_, i) => ({
        id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
        createdAt: `2026-07-18T00:00:${String(i).padStart(2, '0')}.000Z`,
        type: 'api.bulk',
        method: 'POST',
        path: `/api/bulk/${i}`,
        outcome: 'success',
      }));
      const results = await Promise.all(
        events.map((event) => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event,
        })),
      );
      assert.equal(results.length, 20);
      for (const r of results) {
        assert.equal(r.state, 'appended');
      }
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: 20 }, (_, i) => i + 1));
      assert.equal(Math.max(...results.map((r) => r.recordCount)), 21);

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 21);

      const lines = (await readFile(journalAbs(root), 'utf8')).slice(0, -1).split('\n');
      assert.equal(lines.length, 21);
      for (let i = 1; i < lines.length; i += 1) {
        const rec = JSON.parse(lines[i]);
        assert.equal(rec.sequence, i);
        assert.equal(rec.previousLinkDigest, JSON.parse(lines[i - 1]).linkDigest);
      }
    });
  });

  it('10: init∥append concurrent kick: typed outcomes only; final file legal (shared queue)', async () => {
    await withTempRoot('append-init-race', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      // Identify each promise by role — do not blur outcomes in one mixed array.
      const initP1 = initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const appendP1 = appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const appendP2 = appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      const initP2 = initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const appendP3 = appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: {
          id: '44444444-4444-4444-8444-444444444444',
          createdAt: '2026-07-18T00:00:04.000Z',
          type: 'api.race',
          method: 'POST',
          path: '/api/race',
          outcome: 'success',
        },
      });
      const [init1, append1, append2, init2, append3] = await Promise.allSettled([
        initP1,
        appendP1,
        appendP2,
        initP2,
        appendP3,
      ]);

      // Two inits: exactly one fulfilled state=initialized; other rejected already-initialized.
      const initSettled = [init1, init2];
      const initFulfilled = initSettled.filter((r) => r.status === 'fulfilled');
      const initRejected = initSettled.filter((r) => r.status === 'rejected');
      assert.equal(initFulfilled.length, 1, 'exactly one init must succeed');
      assert.equal(initRejected.length, 1, 'exactly one init must lose exclusive create');
      assert.equal(initFulfilled[0].value.state, 'initialized');
      assert.equal(initRejected[0].reason.name, 'AuditIntegrityJournalError');
      assert.equal(
        initRejected[0].reason.code,
        ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED,
      );
      assert.equal(initRejected[0].reason.message, initRejected[0].reason.code);

      // Each append: only fulfilled appended OR rejected not-initialized.
      // chain/io/event-invalid are not legal under this concurrent legal-temp schedule.
      const appendSettled = [append1, append2, append3];
      let fulfilledAppendCount = 0;
      for (const r of appendSettled) {
        if (r.status === 'fulfilled') {
          assert.equal(r.value.state, 'appended', `unexpected append success state ${r.value.state}`);
          fulfilledAppendCount += 1;
        } else {
          assert.equal(r.reason.name, 'AuditIntegrityJournalError');
          assert.equal(
            r.reason.code,
            ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED,
            `append may only reject not-initialized under this schedule, got ${r.reason.code}`,
          );
          assert.equal(r.reason.message, r.reason.code);
        }
      }

      // Journal must exist (at least one init succeeded); no ENOENT/all-rejected escape hatch.
      const raw = await readFile(journalAbs(root), 'utf8');
      assert.ok(raw.endsWith('\n'), 'no partial tail after concurrent init∥append');
      assert.ok(!raw.includes('\n\n'), 'no empty lines from half-writes');
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(
        verified.recordCount,
        1 + fulfilledAppendCount,
        'recordCount === open + fulfilled append count',
      );

      const lines = raw.slice(0, -1).split('\n');
      assert.equal(lines.length, verified.recordCount);
      const records = lines.map((line) => JSON.parse(line));
      const eventRows = records.filter((rec) => rec.recordKind === 'event-link');
      assert.equal(
        eventRows.length,
        fulfilledAppendCount,
        'disk event rows must match fulfilled append count',
      );
      // sequence 0..N continuous; previousLinkDigest chain correct.
      for (let i = 0; i < records.length; i += 1) {
        assert.equal(records[i].sequence, i);
        if (i === 0) {
          assert.equal(records[i].recordKind, 'generation-open');
          assert.equal(records[i].previousLinkDigest, null);
        } else {
          assert.equal(records[i].recordKind, 'event-link');
          assert.equal(records[i].previousLinkDigest, records[i - 1].linkDigest);
        }
      }
    });
  });

  it('11: queue rejection does not poison subsequent task after repair', async () => {
    await withTempRoot('append-queue-poison', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });

      // Break chain: flip linkDigest nibble without recompute.
      const abs = journalAbs(root);
      const raw = await readFile(abs, 'utf8');
      const lines = raw.slice(0, -1).split('\n');
      const rec = JSON.parse(lines[1]);
      rec.linkDigest = (rec.linkDigest[0] === '0' ? '1' : '0') + rec.linkDigest.slice(1);
      lines[1] = canonicalRecordLine(rec);
      await writeFile(abs, `${lines.join('\n')}\n`, { mode: 0o600 });

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );

      // Repair to a fresh legal open-only chain (same path; proves queue not poisoned).
      const { raw: repaired } = buildLegalJournalRaw(GENERATION_ID, 0);
      await writeFile(abs, repaired, { mode: 0o600 });
      const ok = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(ok.state, 'appended');
      assert.equal(ok.sequence, 1);
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 2);
    });
  });

  it('12: middle payload/link not recomputed then append → chain-broken; bytes unchanged', async () => {
    await withTempRoot('append-mid-tamper', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });

      const abs = journalAbs(root);
      const beforeRaw = await readFile(abs, 'utf8');
      const lines = beforeRaw.slice(0, -1).split('\n');
      const mid = JSON.parse(lines[1]);
      // Change payloadDigest without recomputing linkDigest → detectable structure break.
      mid.payloadDigest = mid.payloadDigest[0] === 'a'
        ? `b${mid.payloadDigest.slice(1)}`
        : `a${mid.payloadDigest.slice(1)}`;
      lines[1] = canonicalRecordLine(mid);
      const broken = `${lines.join('\n')}\n`;
      await writeFile(abs, broken, { mode: 0o600 });
      const before = await readFile(abs);

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: {
            id: '55555555-5555-4555-8555-555555555555',
            createdAt: '2026-07-18T00:00:05.000Z',
            type: 'api.x',
            method: 'POST',
            path: '/api/x',
            outcome: 'success',
          },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      assert.deepEqual(await readFile(abs), before);
    });
  });

  it('13: middle line deleted → append and verify chain-broken', async () => {
    await withTempRoot('append-mid-delete', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      const abs = journalAbs(root);
      const lines = (await readFile(abs, 'utf8')).slice(0, -1).split('\n');
      // Delete middle event-link (index 1), leave open + last event.
      const spliced = `${[lines[0], lines[2]].join('\n')}\n`;
      await writeFile(abs, spliced, { mode: 0o600 });

      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: {
            id: '66666666-6666-4666-8666-666666666666',
            createdAt: '2026-07-18T00:00:06.000Z',
            type: 'api.y',
            method: 'POST',
            path: '/api/y',
            outcome: 'success',
          },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
    });
  });

  it('14: reordered event lines → verify chain-broken', async () => {
    await withTempRoot('append-reorder', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      const abs = journalAbs(root);
      const lines = (await readFile(abs, 'utf8')).slice(0, -1).split('\n');
      // Swap two event-link rows.
      const reordered = `${[lines[0], lines[2], lines[1]].join('\n')}\n`;
      await writeFile(abs, reordered, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
    });
  });

  it('15: bad tail/partial crash → verify+append chain-broken; bytes unchanged; no repair/next generation', async () => {
    await withTempRoot('append-partial-tail', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      const abs = journalAbs(root);
      const good = await readFile(abs, 'utf8');
      // Partial crash: strip final newline (half-commit / torn write).
      const partial = good.slice(0, -1);
      await writeFile(abs, partial, { mode: 0o600 });
      const before = await readFile(abs);

      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      assert.deepEqual(await readFile(abs), before);
      // No automatic next generation / repair: file still the same partial bytes.
      assert.equal((await readFile(abs, 'utf8')).endsWith('\n'), false);
    });
  });

  it('16: caller generationId mismatch vs file → chain-broken; bytes unchanged', async () => {
    await withTempRoot('append-gen-mismatch', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID_ALT,
          event: { ...EVENT_A },
        }),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
    });
  });

  it('17: existing===4096 (open counts 1) append succeeds count 4097; verify success', async () => {
    await withTempRoot('append-4096', async (root) => {
      const {
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
        AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES,
        AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND,
      } = await loadJournalModule();
      // 4095 event-links + open = 4096 existing lines.
      const { raw } = buildLegalJournalRaw(GENERATION_ID, 4095);
      await writeJournalRaw(root, raw);
      assert.equal(
        raw.slice(0, -1).split('\n').length,
        AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES,
      );

      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(receipt.state, 'appended');
      assert.equal(receipt.sequence, 4096);
      assert.equal(receipt.recordCount, AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND);

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 4097);
      assert.equal(verified.headDigest, receipt.headDigest);
    });
  });

  it('18: existing 4097 then append → bounds-exceeded not chain; bytes unchanged; no next generation', async () => {
    await withTempRoot('append-4097-bounds', async (root) => {
      const {
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      // Build open + 4095 events, then one real append → 4097, or fixture of 4096 events.
      const { raw } = buildLegalJournalRaw(GENERATION_ID, 4096);
      await writeJournalRaw(root, raw);
      assert.equal(raw.slice(0, -1).split('\n').length, 4097);
      // Pre-state is still structurally valid (verify success at API max).
      const verifiedBefore = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verifiedBefore.state, 'verified');
      assert.equal(verifiedBefore.recordCount, 4097);
      const before = await readFile(journalAbs(root));

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          return true;
        },
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
      // Still one generation only — no automatic next generation file rewrite.
      const lines = (await readFile(journalAbs(root), 'utf8')).slice(0, -1).split('\n');
      assert.equal(lines.length, 4097);
      assert.equal(JSON.parse(lines[0]).generationId, GENERATION_ID);
    });
  });

  it('19: append path per-line>374 → bounds; size>1.5MiB → io (not bounds)', async () => {
    await withTempRoot('append-bounds-line', async (root) => {
      const { appendAuditIntegrityEvent } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      const hugeLine = `${'a'.repeat(375)}\n`;
      await writeFile(journalAbs(root), hugeLine, { mode: 0o600 });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          return true;
        },
      );
    });

    await withTempRoot('append-size-io', async (root) => {
      const {
        appendAuditIntegrityEvent,
        AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
      } = await loadJournalModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      const oversize = `${'x'.repeat(AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES + 1)}\n`;
      await writeFile(journalAbs(root), oversize, { mode: 0o600 });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (error) => {
          assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
          return true;
        },
      );
    });
  });

  it('20: payloadDigest exact independent recompute (write-time only); file has no event raw body', async () => {
    await withTempRoot('append-payload-exact', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      // Independent: DOMAIN_EVENT_PAYLOAD + stringifyStrictCanonicalSanitizedEvent (write-time only).
      // verify will NOT recompute payload preimage or look up events — only format + link input.
      const expectedPayload = independentPayloadDigest(EVENT_A);
      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(receipt.payloadDigest, expectedPayload);

      const fileText = await readFile(journalAbs(root), 'utf8');
      assert.ok(!fileText.includes(EVENT_A.id));
      assert.ok(!fileText.includes(EVENT_A.path));
      assert.ok(!fileText.includes(EVENT_A.type));
      assert.ok(!fileText.includes('createdAt'));
    });
  });

  it('21: events.jsonl unrelated content change leaves journal verify success', async () => {
    await withTempRoot('append-events-unrelated', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await writeFile(
        join(root, 'audit', 'events.jsonl'),
        `${JSON.stringify({ id: 'unrelated-event', note: 'not bound to journal' })}\n`,
        { mode: 0o600 },
      );
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 2);
    });
  });

  it('bad generationId on append → generation-id-invalid path-free', async () => {
    await withTempRoot('append-bad-gen', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: 'NOT-HEX',
          event: { ...EVENT_A },
        }),
        (error) => assertIntegrityError(
          error,
          ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID,
          root,
        ),
      );
    });
  });
});

describe('honest limitations (verify must succeed — design §2.4 / §17)', () => {
  it('23: documents that suffix rewrite is not detected (verify succeeds after recompute-to-end)', async () => {
    // design §2.4 / §17: self-consistent suffix rewrite is NOT detected without external anchor.
    await withTempRoot('limit-suffix-rewrite', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: {
          id: '77777777-7777-4777-8777-777777777777',
          createdAt: '2026-07-18T00:00:07.000Z',
          type: 'api.z',
          method: 'POST',
          path: '/api/z',
          outcome: 'success',
        },
      });

      const abs = journalAbs(root);
      const lines = (await readFile(abs, 'utf8')).slice(0, -1).split('\n');
      const records = lines.map((line) => JSON.parse(line));
      // Intermediate event-link index i=1 (first event-link).
      const i = 1;
      assert.equal(records[i].recordKind, 'event-link');
      // Only change payloadDigest to another legal 64-hex; keep seq/gen/kind/schema/prev for this step.
      const newPayload = records[i].payloadDigest[0] === '0'
        ? `1${records[i].payloadDigest.slice(1)}`
        : `0${records[i].payloadDigest.slice(1)}`;
      records[i].payloadDigest = newPayload;
      // Recompute linkDigest from i to EOF; sync previousLinkDigest for subsequent rows.
      records[i].linkDigest = independentEventLinkDigest({
        generationId: records[i].generationId,
        sequence: records[i].sequence,
        previousLinkDigest: records[i].previousLinkDigest,
        payloadDigest: records[i].payloadDigest,
      });
      for (let j = i + 1; j < records.length; j += 1) {
        records[j].previousLinkDigest = records[j - 1].linkDigest;
        records[j].linkDigest = independentEventLinkDigest({
          generationId: records[j].generationId,
          sequence: records[j].sequence,
          previousLinkDigest: records[j].previousLinkDigest,
          payloadDigest: records[j].payloadDigest,
        });
      }
      const rewritten = `${records.map((r) => canonicalRecordLine(r)).join('\n')}\n`;
      await writeFile(abs, rewritten, { mode: 0o600 });

      // Must succeed: limitation documents that this rewrite is not detected.
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 4);
      assert.equal(verified.generationId, GENERATION_ID);
      assert.equal(verified.headDigest, records[records.length - 1].linkDigest);
    });
  });

  it('24: documents that tail truncation to a valid prefix is not detected (verify succeeds)', async () => {
    // design §2.4 / §17: legal prefix after tail deletion remains self-consistent.
    await withTempRoot('limit-tail-trunc', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      const abs = journalAbs(root);
      const lines = (await readFile(abs, 'utf8')).slice(0, -1).split('\n');
      assert.ok(lines.length >= 3);
      // Drop last event-link → legal open + first event prefix.
      const truncated = `${lines.slice(0, 2).join('\n')}\n`;
      await writeFile(abs, truncated, { mode: 0o600 });

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 2);
      assert.equal(verified.headDigest, JSON.parse(lines[1]).linkDigest);
    });
  });

  it('25: documents that events.jsonl mutation alone is not detected by journal verify', async () => {
    // design §2.4 / §17: no dual-write / events binding → journal verify stays success.
    await withTempRoot('limit-events-only', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      const journalBefore = await readFile(journalAbs(root));

      const eventsPath = join(root, 'audit', 'events.jsonl');
      await writeFile(eventsPath, '{"mutated":true,"secret":"events-only"}\n', { mode: 0o600 });
      await writeFile(eventsPath, '', { mode: 0o600 });

      assert.deepEqual(await readFile(journalAbs(root)), journalBefore);
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 2);
    });
  });

  it('26: documents that full-file replacement with new generationId is not detected (verify succeeds)', async () => {
    // design §2.4 / §17: no external anchor → replacement with new gen self-consistent file succeeds.
    await withTempRoot('limit-full-replace', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });

      const { raw, headDigest, recordCount } = buildLegalJournalRaw(GENERATION_ID_ALT, 2);
      await writeJournalRaw(root, raw);

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.generationId, GENERATION_ID_ALT);
      assert.equal(verified.recordCount, recordCount);
      assert.equal(verified.headDigest, headDigest);
      assert.notEqual(verified.generationId, GENERATION_ID);
    });
  });
});
