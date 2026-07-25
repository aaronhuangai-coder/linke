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
import { watch, writeFileSync, readFileSync } from 'node:fs';
import { access, readFile, writeFile, mkdir, lstat, symlink, rm } from 'node:fs/promises';
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

/**
 * Detect real call sites of a callee name (ignore bare name in comments without `(`).
 * @param {string} source
 * @param {string} name
 * @returns {boolean}
 */
function hasCallSite(source, name) {
  return new RegExp(`\\b${name}\\s*\\(`).test(String(source));
}

describe('shared write queue + plan/publish source contract (V1.37 C1)', () => {
  it('C1: journal has no private queue Map; shared enqueue once; plan+publish atomic SoT; ban audit-log/server/events wiring', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const sourcePath = new URL('../src/audit-integrity-journal.js', import.meta.url);
    const source = await rf(sourcePath, 'utf8');
    const queueSourcePath = new URL('../src/audit-integrity-write-queue.js', import.meta.url);
    const queueSource = await rf(queueSourcePath, 'utf8');

    // Journal no longer owns a Map queue; shared module is sole Map.
    assert.equal(source.includes('auditIntegrityJournalQueues'), false);
    assert.equal(source.includes('enqueueAuditIntegrityJournalTask'), false);
    assert.equal((source.match(/new Map\s*\(\s*\)/g) || []).length, 0);
    assert.equal((queueSource.match(/new Map\s*\(\s*\)/g) || []).length, 1);
    assert.ok(source.includes("from './audit-integrity-write-queue.js'"));
    assert.ok(source.includes('enqueueAuditIntegrityWriteTask'));
    assert.ok(source.includes('assertAuditIntegrityWriteLease'));

    // Public init+append each return shared enqueue once.
    assert.ok(source.includes('export async function initializeAuditIntegrityJournal'));
    assert.ok(source.includes('export async function appendAuditIntegrityEvent'));
    const returnEnqueue = source.match(/return enqueueAuditIntegrityWriteTask\s*\(/g) || [];
    assert.ok(returnEnqueue.length >= 2, 'init and append must both return shared enqueue');
    assert.equal(
      (source.match(/\benqueueAuditIntegrityWriteTask\s*\(/g) || []).length,
      2,
      'public wrappers enqueue exactly once each (2 call sites total)',
    );

    // Plan + publish unique SoT; no safeAppend on journal path.
    assert.ok(source.includes('planAuditIntegrityEventLinkUnlocked'));
    assert.ok(source.includes('publishPlannedAuditIntegrityEventLinkAtomicUnlocked'));
    assert.ok(source.includes('appendAuditIntegrityEventUnlocked'));
    assert.ok(source.includes('initializeAuditIntegrityJournalUnlocked'));
    assert.ok(hasCallSite(source, 'safeAtomicWriteText'));
    assert.equal(hasCallSite(source, 'safeAppendText'), false, 'event-link must not safeAppendText');
    assert.equal(source.includes('safeAppendText'), false);
    // Unlocked append must call plan + publish (unique SoT; no formula fork path).
    assert.ok(hasCallSite(source, 'planAuditIntegrityEventLinkUnlocked'));
    assert.ok(hasCallSite(source, 'publishPlannedAuditIntegrityEventLinkAtomicUnlocked'));
    // Publish after-write MUST re-read + verify (source contract if swap inject hard).
    const publishIdx = source.indexOf('export async function publishPlannedAuditIntegrityEventLinkAtomicUnlocked');
    assert.ok(publishIdx >= 0);
    const publishBody = source.slice(publishIdx, publishIdx + 2500);
    assert.ok(publishBody.includes('safeAtomicWriteText'));
    assert.ok(publishBody.includes('safeReadText'));
    assert.ok(publishBody.includes('verifyRawJournal'));
    // Plan stores raw in module-private WeakMap.
    assert.ok(source.includes('WeakMap'));
    assert.ok(source.includes('auditIntegrityJournalPlanPayloads'));
    // Forbidden ambiguous publish(rawPre, recordLine).
    assert.equal(source.includes('publishAuditIntegrityEventLinkAtomicUnlocked'), false);
    // C2+: real state-absent gate inside shared queue callback (not stub/always-allow).
    assert.ok(source.includes('assertDualWriteStateAbsentUnlocked'));
    assert.ok(source.includes("from './audit-integrity-dual-write-state.js'"));
    assert.equal(source.includes('always-allow'), false);
    assert.equal(source.includes('TODO'), false);

    assert.ok(
      source.includes("from './audit-event-schema.js'")
        || source.includes('from "./audit-event-schema.js"'),
      'schema import for strict stringify',
    );
    assert.ok(source.includes('stringifyStrictCanonicalSanitizedEvent'));

    assert.ok(!source.includes("from './audit-log.js'"));
    assert.ok(!source.includes("from './server.js'"));
    assert.ok(!source.includes("from '../server.js'"));
    assert.ok(!source.includes('appendAuditEvent'));
    assert.ok(!/from\s+['"][^'"]*events\.jsonl['"]/.test(source));
    assert.ok(!source.includes('AUDIT_EVENTS'));
    assert.ok(!source.includes("relativePath: 'audit/events.jsonl'"));

    const mod = await loadJournalModule();
    assert.equal(typeof mod.initializeAuditIntegrityJournal, 'function');
    assert.equal(typeof mod.verifyAuditIntegrityJournalFile, 'function');
    assert.equal(typeof mod.appendAuditIntegrityEvent, 'function');
    assert.equal(typeof mod.planAuditIntegrityEventLinkUnlocked, 'function');
    assert.equal(typeof mod.publishPlannedAuditIntegrityEventLinkAtomicUnlocked, 'function');
    assert.equal(typeof mod.appendAuditIntegrityEventUnlocked, 'function');
    assert.equal(typeof mod.initializeAuditIntegrityJournalUnlocked, 'function');
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

describe('computeAuditIntegrityEventPayloadDigest + inspectAuditIntegrityJournalFile (V1.36 C1)', () => {
  it('1: compute fixed strict event equals independent SHA256(domain+shared canonical)', async () => {
    const { computeAuditIntegrityEventPayloadDigest } = await loadJournalModule();
    const expected = independentPayloadDigest(EVENT_A);
    const actual = computeAuditIntegrityEventPayloadDigest({ ...EVENT_A });
    assert.equal(actual, expected);
    assert.match(actual, /^[0-9a-f]{64}$/);
  });

  it('2: compute equals append receipt payloadDigest for same strict event', async () => {
    await withTempRoot('c1-compute-append', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        computeAuditIntegrityEventPayloadDigest,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const computed = computeAuditIntegrityEventPayloadDigest({ ...EVENT_A });
      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(receipt.payloadDigest, computed);
      assert.equal(computed, independentPayloadDigest(EVENT_A));
    });
  });

  it('3: strict failures (missing id / Proxy / extra / accessor) → EVENT_INVALID message===code; no sanitize; no SECRET', async () => {
    const {
      computeAuditIntegrityEventPayloadDigest,
      AuditIntegrityJournalError,
    } = await loadJournalModule();

    const assertEventInvalid = (error) => {
      assert.ok(error instanceof AuditIntegrityJournalError);
      assert.equal(error.name, 'AuditIntegrityJournalError');
      assert.equal(error.code, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
      assert.equal(error.message, ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
      assert.equal(error.message, error.code);
      assert.ok(!error.message.includes('SECRET'));
      assert.ok(!String(error.stack || '').split('\n')[0].includes('SECRET'));
      assert.ok(!error.message.includes('ENOENT'));
      assert.ok(!error.message.includes('/var/'));
      return true;
    };

    // missing id — strict rejects; must not invent/sanitize id
    assert.throws(
      () => computeAuditIntegrityEventPayloadDigest({
        createdAt: EVENT_A.createdAt,
        type: 'api.test',
        method: 'POST',
        path: '/api/test',
        outcome: 'success',
      }),
      assertEventInvalid,
    );

    // missing createdAt
    assert.throws(
      () => computeAuditIntegrityEventPayloadDigest({
        id: EVENT_A.id,
        type: 'api.test',
        method: 'POST',
        path: '/api/test',
        outcome: 'success',
      }),
      assertEventInvalid,
    );

    // extra key
    assert.throws(
      () => computeAuditIntegrityEventPayloadDigest({ ...EVENT_A, extra: 'nope' }),
      assertEventInvalid,
    );

    // noncanonical createdAt (sanitize would rewrite; strict rejects)
    assert.throws(
      () => computeAuditIntegrityEventPayloadDigest({
        ...EVENT_A,
        createdAt: '2026-07-18T00:00:00Z',
      }),
      assertEventInvalid,
    );

    // Proxy hostile
    const proxyEvent = new Proxy({ ...EVENT_A }, {
      get() {
        throw new Error('SECRET-EVENT-PROXY');
      },
    });
    assert.throws(
      () => computeAuditIntegrityEventPayloadDigest(proxyEvent),
      assertEventInvalid,
    );

    // accessor id
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
    assert.throws(
      () => computeAuditIntegrityEventPayloadDigest(accessorEvent),
      assertEventInvalid,
    );
  });

  it('4: inspect after init+2append — exact allowlist snapshot matching verify/append digests', async () => {
    await withTempRoot('c1-inspect-ok', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
        inspectAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      const verified = await verifyAuditIntegrityJournalFile(root);
      const snapshot = await inspectAuditIntegrityJournalFile(root);

      assert.deepEqual(snapshot, {
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        recordCount: 3,
        eventCount: 2,
        payloadDigests: [a1.payloadDigest, a2.payloadDigest],
      });
      assert.equal(snapshot.generationId, verified.generationId);
      assert.equal(snapshot.headDigest, verified.headDigest);
      assert.equal(snapshot.recordCount, verified.recordCount);
      assert.equal(snapshot.eventCount, 2);
      assert.equal(snapshot.payloadDigests[0], a1.payloadDigest);
      assert.equal(snapshot.payloadDigests[1], a2.payloadDigest);
      assert.equal(snapshot.payloadDigests[0], independentPayloadDigest(EVENT_A));
      assert.equal(snapshot.payloadDigests[1], independentPayloadDigest(EVENT_B));
      assert.equal(
        Object.keys(snapshot).join(','),
        'generationId,headDigest,recordCount,eventCount,payloadDigests',
      );
    });
  });

  it('5: payloadDigests exclude generation-open null; order is event-link only', async () => {
    await withTempRoot('c1-inspect-no-open-null', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      // open-only: eventCount 0, empty digests, no null from open
      const openOnly = await inspectAuditIntegrityJournalFile(root);
      assert.equal(openOnly.recordCount, 1);
      assert.equal(openOnly.eventCount, 0);
      assert.deepEqual(openOnly.payloadDigests, []);
      assert.equal(openOnly.payloadDigests.length, 0);
      assert.ok(!openOnly.payloadDigests.includes(null));

      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      const snapshot = await inspectAuditIntegrityJournalFile(root);
      assert.equal(snapshot.eventCount, 2);
      assert.equal(snapshot.payloadDigests.length, 2);
      assert.deepEqual([...snapshot.payloadDigests], [a1.payloadDigest, a2.payloadDigest]);
      assert.ok(!snapshot.payloadDigests.includes(null));
      assert.equal(snapshot.eventCount, snapshot.payloadDigests.length);
    });
  });

  it('6: inspect missing journal → not-initialized (same code as verify)', async () => {
    await withTempRoot('c1-inspect-missing', async (root) => {
      const {
        inspectAuditIntegrityJournalFile,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await assert.rejects(
        () => inspectAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(
          error,
          ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED,
          root,
        ),
      );
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

  it('7: inspect chain-broken → no partial snapshot; same typed code as verify', async () => {
    await withTempRoot('c1-inspect-broken', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const abs = journalAbs(root);
      const raw = await readFile(abs, 'utf8');
      const lines = raw.slice(0, -1).split('\n');
      const rec = JSON.parse(lines[1]);
      rec.linkDigest = (rec.linkDigest[0] === '0' ? '1' : '0') + rec.linkDigest.slice(1);
      lines[1] = canonicalRecordLine(rec);
      await writeFile(abs, `${lines.join('\n')}\n`, { mode: 0o600 });

      let inspectResult = null;
      await assert.rejects(
        async () => {
          inspectResult = await inspectAuditIntegrityJournalFile(root);
        },
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
      assert.equal(inspectResult, null, 'must not assign partial snapshot on chain-broken');

      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
      );
    });
  });

  it('8: payloadDigests is new frozen copy; push/index mutation cannot pollute next inspect', async () => {
    await withTempRoot('c1-inspect-freeze-digests', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });

      const snap1 = await inspectAuditIntegrityJournalFile(root);
      assert.equal(Object.isFrozen(snap1.payloadDigests), true);
      const originalDigests = [a1.payloadDigest, a2.payloadDigest];
      assert.deepEqual([...snap1.payloadDigests], originalDigests);

      // push on frozen array must throw in strict mode (node:test is ESM strict)
      assert.throws(() => {
        snap1.payloadDigests.push('f'.repeat(64));
      }, TypeError);
      assert.throws(() => {
        snap1.payloadDigests[0] = '0'.repeat(64);
      }, TypeError);

      const snap2 = await inspectAuditIntegrityJournalFile(root);
      assert.notEqual(snap2.payloadDigests, snap1.payloadDigests, 'must be a new array copy');
      assert.deepEqual([...snap2.payloadDigests], originalDigests);
      assert.equal(snap2.payloadDigests.length, 2);
      assert.equal(Object.isFrozen(snap2.payloadDigests), true);
    });
  });

  it('9: snapshot object itself frozen (or field mutation cannot pollute next inspect)', async () => {
    await withTempRoot('c1-inspect-freeze-snapshot', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });

      const snap1 = await inspectAuditIntegrityJournalFile(root);
      const expected = {
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        recordCount: 3,
        eventCount: 2,
        payloadDigests: [a1.payloadDigest, a2.payloadDigest],
      };
      assert.deepEqual(
        {
          generationId: snap1.generationId,
          headDigest: snap1.headDigest,
          recordCount: snap1.recordCount,
          eventCount: snap1.eventCount,
          payloadDigests: [...snap1.payloadDigests],
        },
        expected,
      );

      // Prefer freeze; if frozen, assignment throws; either way next inspect is clean.
      if (Object.isFrozen(snap1)) {
        assert.throws(() => {
          snap1.generationId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        }, TypeError);
        assert.throws(() => {
          snap1.recordCount = 999;
        }, TypeError);
        assert.throws(() => {
          snap1.headDigest = 'e'.repeat(64);
        }, TypeError);
        assert.throws(() => {
          snap1.eventCount = 0;
        }, TypeError);
      } else {
        snap1.generationId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        snap1.recordCount = 999;
        snap1.headDigest = 'e'.repeat(64);
        snap1.eventCount = 0;
      }

      const snap2 = await inspectAuditIntegrityJournalFile(root);
      assert.deepEqual(
        {
          generationId: snap2.generationId,
          headDigest: snap2.headDigest,
          recordCount: snap2.recordCount,
          eventCount: snap2.eventCount,
          payloadDigests: [...snap2.payloadDigests],
        },
        expected,
      );
      assert.notEqual(snap2, snap1);
    });
  });

  it('10: hostile options getter/Proxy — zero property reads; exact snapshot; no pollute', async () => {
    await withTempRoot('c1-inspect-hostile-opts', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });

      // Inspect contract: root-only; options slot is reserved and must never touch properties.
      // Counters lock zero reads — any future options getter/trap map-to-error would fail here.
      let getterReadCount = 0;
      const hostileGetter = Object.defineProperty({}, 'generationId', {
        enumerable: true,
        get() {
          getterReadCount += 1;
          throw new Error(`SECRET-GETTER path=${root} errno=ENOENT`);
        },
      });
      Object.defineProperty(hostileGetter, 'deps', {
        enumerable: true,
        get() {
          getterReadCount += 1;
          throw new Error('SECRET-DEPS');
        },
      });

      let proxyTrapCount = 0;
      const hostileProxy = new Proxy({}, {
        get(_t, prop) {
          proxyTrapCount += 1;
          throw new Error(`SECRET-PROXY prop=${String(prop)} path=${root}`);
        },
        ownKeys() {
          proxyTrapCount += 1;
          throw new Error('SECRET-PROXY-OWNKEYS');
        },
        getOwnPropertyDescriptor() {
          proxyTrapCount += 1;
          throw new Error('SECRET-PROXY-GOPD');
        },
        has() {
          proxyTrapCount += 1;
          throw new Error('SECRET-PROXY-HAS');
        },
      });

      // Direct success path only — no try/catch fallback that would green on mapped typed errors.
      const snapFromGetter = await inspectAuditIntegrityJournalFile(root, hostileGetter);
      const snapFromProxy = await inspectAuditIntegrityJournalFile(root, hostileProxy);
      assert.equal(getterReadCount, 0, 'inspect must not read hostile getter properties');
      assert.equal(proxyTrapCount, 0, 'inspect must not trigger hostile Proxy traps');

      const SNAPSHOT_KEYS = [
        'generationId',
        'headDigest',
        'recordCount',
        'eventCount',
        'payloadDigests',
      ];
      const expectedValues = {
        generationId: GENERATION_ID,
        recordCount: 2,
        eventCount: 1,
        payloadDigests: [a1.payloadDigest],
      };

      // Both hostile-option snapshots: exact 5-key allowlist + value equality to clean inspect.
      assert.deepEqual(Object.keys(snapFromGetter), SNAPSHOT_KEYS);
      assert.deepEqual(Object.keys(snapFromProxy), SNAPSHOT_KEYS);
      assert.equal(snapFromGetter.generationId, expectedValues.generationId);
      assert.equal(snapFromGetter.recordCount, expectedValues.recordCount);
      assert.equal(snapFromGetter.eventCount, expectedValues.eventCount);
      assert.deepEqual([...snapFromGetter.payloadDigests], expectedValues.payloadDigests);
      assert.equal(snapFromProxy.generationId, expectedValues.generationId);
      assert.equal(snapFromProxy.recordCount, expectedValues.recordCount);
      assert.equal(snapFromProxy.eventCount, expectedValues.eventCount);
      assert.deepEqual([...snapFromProxy.payloadDigests], expectedValues.payloadDigests);

      assert.equal(Object.isFrozen(snapFromGetter.payloadDigests), true);
      assert.equal(Object.isFrozen(snapFromProxy.payloadDigests), true);
      assert.notEqual(
        snapFromGetter.payloadDigests,
        snapFromProxy.payloadDigests,
        'hostile paths must not share payloadDigests array refs',
      );

      // Module state / disk unchanged: verify + clean inspect still succeed with expected digests.
      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 2);
      const clean = await inspectAuditIntegrityJournalFile(root);
      assert.deepEqual(Object.keys(clean), SNAPSHOT_KEYS);
      assert.equal(clean.generationId, GENERATION_ID);
      assert.equal(clean.recordCount, 2);
      assert.equal(clean.eventCount, 1);
      assert.deepEqual([...clean.payloadDigests], [a1.payloadDigest]);
      assert.equal(clean.headDigest, verified.headDigest);
      assert.equal(snapFromGetter.headDigest, clean.headDigest);
      assert.equal(snapFromProxy.headDigest, clean.headDigest);
      assert.deepEqual(
        {
          generationId: snapFromGetter.generationId,
          headDigest: snapFromGetter.headDigest,
          recordCount: snapFromGetter.recordCount,
          eventCount: snapFromGetter.eventCount,
          payloadDigests: [...snapFromGetter.payloadDigests],
        },
        {
          generationId: clean.generationId,
          headDigest: clean.headDigest,
          recordCount: clean.recordCount,
          eventCount: clean.eventCount,
          payloadDigests: [...clean.payloadDigests],
        },
      );
      assert.deepEqual(
        {
          generationId: snapFromProxy.generationId,
          headDigest: snapFromProxy.headDigest,
          recordCount: snapFromProxy.recordCount,
          eventCount: snapFromProxy.eventCount,
          payloadDigests: [...snapFromProxy.payloadDigests],
        },
        {
          generationId: clean.generationId,
          headDigest: clean.headDigest,
          recordCount: clean.recordCount,
          eventCount: clean.eventCount,
          payloadDigests: [...clean.payloadDigests],
        },
      );
      assert.notEqual(snapFromGetter.payloadDigests, clean.payloadDigests);
      assert.notEqual(snapFromProxy.payloadDigests, clean.payloadDigests);
      assert.equal(Object.isFrozen(clean.payloadDigests), true);

      // After hostile attempts, a subsequent inspect still returns a fresh clean snapshot.
      const again = await inspectAuditIntegrityJournalFile(root);
      assert.deepEqual([...again.payloadDigests], [a1.payloadDigest]);
      assert.equal(again.headDigest, clean.headDigest);
      assert.notEqual(again.payloadDigests, clean.payloadDigests);
      assert.notEqual(again.payloadDigests, snapFromGetter.payloadDigests);
      assert.notEqual(again.payloadDigests, snapFromProxy.payloadDigests);
      // Counters remain zero after clean/again (no late options touch).
      assert.equal(getterReadCount, 0);
      assert.equal(proxyTrapCount, 0);
    });
  });

  it('11: inspect snapshot exact key allowlist — no raw/path/body/linkDigest list/ok/state', async () => {
    await withTempRoot('c1-inspect-allowlist', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const snapshot = await inspectAuditIntegrityJournalFile(root);
      const keys = Object.keys(snapshot);
      assert.deepEqual(keys, [
        'generationId',
        'headDigest',
        'recordCount',
        'eventCount',
        'payloadDigests',
      ]);
      assert.equal(keys.join(','), 'generationId,headDigest,recordCount,eventCount,payloadDigests');

      // Forbidden surface fields
      assert.equal('records' in snapshot, false);
      assert.equal('raw' in snapshot, false);
      assert.equal('path' in snapshot, false);
      assert.equal('relativePath' in snapshot, false);
      assert.equal('events' in snapshot, false);
      assert.equal('event' in snapshot, false);
      assert.equal('body' in snapshot, false);
      assert.equal('linkDigests' in snapshot, false);
      assert.equal('linkDigest' in snapshot, false);
      assert.equal('ok' in snapshot, false);
      assert.equal('state' in snapshot, false);
      assert.equal('previousLinkDigest' in snapshot, false);
      assert.equal('sequence' in snapshot, false);

      // payloadDigests hold digests only — not event body fields
      const digestsJson = JSON.stringify(snapshot.payloadDigests);
      assert.ok(!digestsJson.includes(EVENT_A.id));
      assert.ok(!digestsJson.includes('/api/test'));
      assert.ok(!digestsJson.includes('createdAt'));
      assert.ok(!JSON.stringify(snapshot).includes(root));
      assert.ok(!JSON.stringify(snapshot).includes('integrity-journal.jsonl'));
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

describe('V1.37 C1 plan/publish unique SoT + lease', () => {
  async function withLease(root, fn) {
    const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
    const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
    const resolvedRoot = await assertSafeDataRoot(root);
    return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
  }

  it('public append still succeeds; receipt fields unchanged; mode 0600; trailing newline', async () => {
    await withTempRoot('c1-public-append', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(receipt.state, 'appended');
      assert.equal(receipt.generationId, GENERATION_ID);
      assert.equal(receipt.sequence, 1);
      assert.equal(receipt.recordCount, 2);
      assert.equal(typeof receipt.headDigest, 'string');
      assert.equal(receipt.payloadDigest, independentPayloadDigest(EVENT_A));
      assert.equal(
        Object.keys(receipt).join(','),
        'state,generationId,sequence,recordCount,headDigest,payloadDigest',
      );
      const abs = journalAbs(root);
      const st = await lstat(abs);
      assert.equal(st.mode & 0o777, 0o600);
      const raw = await readFile(abs, 'utf8');
      assert.ok(raw.endsWith('\n'));
      assert.equal((await verifyAuditIntegrityJournalFile(root)).state, 'verified');
    });
  });

  it('plan has no filesystem mutation; journal bytes identical before/after plan', async () => {
    await withTempRoot('c1-plan-readonly', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        planAuditIntegrityEventLinkUnlocked,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));
      await withLease(root, async (resolvedRoot, lease) => {
        await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });
      });
      assert.deepEqual(await readFile(journalAbs(root)), before);
    });
  });

  it('plan same pre+input is idempotent; frozen; no raw/path/body keys', async () => {
    await withTempRoot('c1-plan-meta', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        planAuditIntegrityEventLinkUnlocked,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await withLease(root, async (resolvedRoot, lease) => {
        const p1 = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });
        const p2 = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });
        assert.deepEqual(p1, p2);
        assert.ok(Object.isFrozen(p1));
        assert.ok(Object.isFrozen(p1.pre));
        assert.ok(Object.isFrozen(p1.post));
        assert.equal(p1.generationId, GENERATION_ID);
        assert.equal(p1.payloadDigest, independentPayloadDigest(EVENT_A));
        assert.equal(p1.pre.recordCount, 1);
        assert.equal(p1.post.recordCount, 2);
        assert.equal(p1.post.sequence, 1);
        assert.equal(typeof p1.pre.rawSha256, 'string');
        assert.equal(typeof p1.post.rawSha256, 'string');
        assert.equal(p1.pre.rawSha256.length, 64);
        // No caller-accessible raw/path/body.
        for (const key of Object.keys(p1)) {
          assert.ok(!/rawPre|rawPost|recordLine|pathname|path|event|body/i.test(key));
        }
        assert.equal('rawPreText' in p1, false);
        assert.equal('rawPostText' in p1, false);
        assert.equal('rawPre' in p1, false);
        assert.equal('rawPost' in p1, false);
        // Mutating frozen plan fields must throw.
        assert.throws(() => {
          p1.generationId = 'x';
        });
        assert.throws(() => {
          p1.post.sequence = 99;
        });
      });
    });
  });

  it('public append and unlocked plan+publish yield identical receipt hashes', async () => {
    await withTempRoot('c1-public-vs-direct', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        planAuditIntegrityEventLinkUnlocked,
        publishPlannedAuditIntegrityEventLinkAtomicUnlocked,
      } = await loadJournalModule();

      // Path A: public append.
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const publicReceipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const publicRaw = await readFile(journalAbs(root), 'utf8');

      // Path B: unlocked plan+publish on a twin root.
      await withTempRoot('c1-public-vs-direct-b', async (rootB) => {
        await initializeAuditIntegrityJournal(rootB, { generationId: GENERATION_ID });
        const directReceipt = await withLease(rootB, async (resolvedRoot, lease) => {
          const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
            generationId: GENERATION_ID,
            event: { ...EVENT_A },
          });
          return publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan);
        });
        const directRaw = await readFile(journalAbs(rootB), 'utf8');
        assert.deepEqual(directReceipt, publicReceipt);
        assert.equal(directRaw, publicRaw);
      });
    });
  });

  it('unlocked without lease / wrong lease → SafeDataFileError', async () => {
    await withTempRoot('c1-lease-req', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        planAuditIntegrityEventLinkUnlocked,
        appendAuditIntegrityEventUnlocked,
        initializeAuditIntegrityJournalUnlocked,
      } = await loadJournalModule();
      const { SafeDataFileError } = await import('../src/safe-data-files.js');
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const resolvedRoot = await assertSafeDataRoot(root);
      const fakeLease = Object.freeze({});
      await assert.rejects(
        () => planAuditIntegrityEventLinkUnlocked(resolvedRoot, fakeLease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => e instanceof SafeDataFileError,
      );
      await assert.rejects(
        () => appendAuditIntegrityEventUnlocked(resolvedRoot, fakeLease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => e instanceof SafeDataFileError,
      );
      await assert.rejects(
        () => initializeAuditIntegrityJournalUnlocked(resolvedRoot, fakeLease, {
          generationId: GENERATION_ID,
        }),
        (e) => e instanceof SafeDataFileError,
      );
    });
  });

  it('publish rejects forged / wrong-root / expired lease / consumed plan; external pre mutation', async () => {
    await withTempRoot('c1-publish-reject', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        planAuditIntegrityEventLinkUnlocked,
        publishPlannedAuditIntegrityEventLinkAtomicUnlocked,
      } = await loadJournalModule();
      const { SafeDataFileError } = await import('../src/safe-data-files.js');
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });

      // Forged plan (no WeakMap brand).
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, {
            generationId: GENERATION_ID,
            payloadDigest: 'a'.repeat(64),
            pre: {},
            post: {},
          }),
          (e) => e instanceof SafeDataFileError,
        );
      });

      // Wrong root: active lease for A cannot be asserted/published as root B.
      await withTempRoot('c1-pub-wrong-root', async (rootB) => {
        const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
        const resolvedB = await assertSafeDataRoot(rootB);
        await withLease(root, async (resolvedRoot, lease) => {
          const planFromA = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
            generationId: GENERATION_ID,
            event: { ...EVENT_A },
          });
          await assert.rejects(
            () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedB, lease, planFromA),
            (e) => e instanceof SafeDataFileError,
          );
        });
      });

      // Expired lease identity: plan under lease1, publish later with fresh lease2.
      let planHeld;
      await withLease(root, async (resolvedRoot, lease) => {
        planHeld = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });
      });
      await withLease(root, async (resolvedRoot, lease2) => {
        await assert.rejects(
          () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease2, planHeld),
          (e) => e instanceof SafeDataFileError,
        );
      });

      // External mutation between plan and publish → CHAIN_BROKEN; mutated bytes kept.
      await withLease(root, async (resolvedRoot, lease) => {
        const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });
        const abs = journalAbs(root);
        const mutated = `${(await readFile(abs, 'utf8')).trimEnd()}\n`;
        // Flip open link nibble to change raw without leaving empty.
        const lines = mutated.slice(0, -1).split('\n');
        const open = JSON.parse(lines[0]);
        open.linkDigest = (open.linkDigest[0] === '0' ? '1' : '0') + open.linkDigest.slice(1);
        // Keep illegal chain intentionally for rawPre mismatch (publish compares exact raw).
        const brokenRaw = `${canonicalRecordLine(open)}\n`;
        await writeFile(abs, brokenRaw, { mode: 0o600 });
        const before = await readFile(abs);
        await assert.rejects(
          () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan),
          (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root),
        );
        assert.deepEqual(await readFile(abs), before);
      });
    });
  });

  it('plan one-shot: second publish after success rejects; caller-stuffed raw ignored', async () => {
    await withTempRoot('c1-oneshot', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        planAuditIntegrityEventLinkUnlocked,
        publishPlannedAuditIntegrityEventLinkAtomicUnlocked,
      } = await loadJournalModule();
      const { SafeDataFileError } = await import('../src/safe-data-files.js');
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await withLease(root, async (resolvedRoot, lease) => {
        const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });
        // Caller cannot inject raw fields into frozen plan.
        assert.throws(() => {
          // @ts-ignore
          plan.rawPostText = 'evil\n';
        });
        const receipt = await publishPlannedAuditIntegrityEventLinkAtomicUnlocked(
          resolvedRoot,
          lease,
          plan,
        );
        assert.equal(receipt.state, 'appended');
        await assert.rejects(
          () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan),
          (e) => e instanceof SafeDataFileError,
        );
      });
    });
  });

  it('one-shot boundary: wrong-root precheck does not consume; correct publish then consumes', async () => {
    await withTempRoot('c1-oneshot-boundary-a', async (rootA) => {
      await withTempRoot('c1-oneshot-boundary-b', async (rootB) => {
        const {
          initializeAuditIntegrityJournal,
          planAuditIntegrityEventLinkUnlocked,
          publishPlannedAuditIntegrityEventLinkAtomicUnlocked,
        } = await loadJournalModule();
        const { SafeDataFileError, assertSafeDataRoot } = await import('../src/safe-data-files.js');
        await initializeAuditIntegrityJournal(rootA, { generationId: GENERATION_ID });
        const resolvedB = await assertSafeDataRoot(rootB);

        await withLease(rootA, async (resolvedA, lease) => {
          const plan = await planAuditIntegrityEventLinkUnlocked(resolvedA, lease, {
            generationId: GENERATION_ID,
            event: { ...EVENT_A },
          });

          // Pre-check (wrong root / lease-root mismatch) fails outside consumption.
          await assert.rejects(
            () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedB, lease, plan),
            (e) => e instanceof SafeDataFileError,
          );

          // Same plan still publishable under correct root-A + same active lease.
          const receipt = await publishPlannedAuditIntegrityEventLinkAtomicUnlocked(
            resolvedA,
            lease,
            plan,
          );
          assert.equal(receipt.state, 'appended');
          assert.equal(receipt.payloadDigest, independentPayloadDigest(EVENT_A));

          // Third attempt: plan already consumed by the successful publish attempt.
          await assert.rejects(
            () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedA, lease, plan),
            (e) => e instanceof SafeDataFileError,
          );
        });
      });
    });
  });

  it('public append call-time event snapshot survives shared-queue mutation window (TOCTOU)', async () => {
    await withTempRoot('c1-event-toctou', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournalModule();
      const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const resolvedRoot = await assertSafeDataRoot(root);

      let releaseBlocker;
      let signalBlockerStarted;
      const blockerStarted = new Promise((resolve) => {
        signalBlockerStarted = resolve;
      });
      const blockerGate = new Promise((resolve) => {
        releaseBlocker = resolve;
      });

      // Occupy the same-root shared queue so public append must wait after enqueue.
      const blockP = enqueueAuditIntegrityWriteTask(resolvedRoot, async () => {
        signalBlockerStarted();
        await blockerGate;
      });
      await blockerStarted;

      const mutable = { ...EVENT_A };
      const callTimeDigest = independentPayloadDigest({ ...EVENT_A });
      const mutatedEvent = { ...EVENT_A, path: '/api/mutated-after-enqueue' };
      const mutatedDigest = independentPayloadDigest(mutatedEvent);
      assert.notEqual(callTimeDigest, mutatedDigest);

      const appendP = appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: mutable,
      });

      // Drain enough turns for public append to finish pre-enqueue work and join the queue
      // behind the blocker. Append must still be pending (queue window proven).
      let appendSettled = false;
      appendP.then(
        () => {
          appendSettled = true;
        },
        () => {
          appendSettled = true;
        },
      );
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (appendSettled) {
          throw new Error('append settled before queue blocker released — window not established');
        }
      }
      assert.equal(appendSettled, false, 'append must remain queued behind shared-root blocker');

      // Hostile caller mutates the original object while the task is still queued.
      mutable.path = mutatedEvent.path;

      releaseBlocker();
      await blockP;
      const receipt = await appendP;

      assert.equal(receipt.state, 'appended');
      assert.equal(receipt.payloadDigest, callTimeDigest);
      assert.notEqual(receipt.payloadDigest, mutatedDigest);

      const lines = (await readFile(journalAbs(root), 'utf8')).slice(0, -1).split('\n');
      assert.equal(lines.length, 2);
      const eventLink = JSON.parse(lines[1]);
      assert.equal(eventLink.payloadDigest, callTimeDigest);
      assert.notEqual(eventLink.payloadDigest, mutatedDigest);

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.equal(verified.state, 'verified');
      assert.equal(verified.recordCount, 2);
    });
  });

  it('post-rename swap before post-verify → CHAIN_BROKEN; no success; injected bytes remain', async () => {
    await withTempRoot('c1-post-rename-swap', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        planAuditIntegrityEventLinkUnlocked,
        publishPlannedAuditIntegrityEventLinkAtomicUnlocked,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });

      // Narrow structural order supplement (runtime swap below is the acceptance criterion).
      const source = await readFile(new URL('../src/audit-integrity-journal.js', import.meta.url), 'utf8');
      const pubStart = source.indexOf('export async function publishPlannedAuditIntegrityEventLinkAtomicUnlocked');
      assert.ok(pubStart >= 0);
      const nextExport = source.indexOf('\nexport ', pubStart + 10);
      const pubBody = source.slice(pubStart, nextExport === -1 ? undefined : nextExport);
      const atomicAt = pubBody.indexOf('safeAtomicWriteText');
      const postReadAt = pubBody.indexOf('safeReadText', atomicAt + 1);
      const verifyAt = pubBody.indexOf('verifyRawJournal', atomicAt + 1);
      assert.ok(atomicAt >= 0 && postReadAt > atomicAt && verifyAt > postReadAt);

      const abs = journalAbs(root);
      const auditDir = join(root, 'audit');
      const injectedBytes = 'POST_RENAME_SWAP_INJECTED_CORRUPT_BYTES\n';

      await withLease(root, async (resolvedRoot, lease) => {
        const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        });

        // Arm AFTER plan, BEFORE publish.
        // macOS FSEvents can deliver final-leaf rename before rename(2) commits the new
        // inode, so a sync writeFileSync in the watcher callback is often overwritten by
        // the still-pending atomic rename (fake-green / lost inject). Deterministic path:
        // directory watcher observes final `integrity-journal.jsonl` (ignore .tmp-*), then
        // a concurrent poller waits until on-disk bytes differ from pre-plan (rename
        // committed) and only then sync-overwrites final before publish post-verify.
        const preBytes = await readFile(abs);
        let injected = false;
        let finalLeafObserved = false;

        const tryInjectAfterRenameCommit = () => {
          if (injected) return;
          try {
            const cur = readFileSync(abs);
            if (cur.equals(preBytes)) return;
            if (cur.toString('utf8') === injectedBytes) {
              injected = true;
              return;
            }
            writeFileSync(abs, injectedBytes);
            injected = true;
          } catch {
            // Mid-rename ENOENT / transient — keep polling.
          }
        };

        const watcher = watch(auditDir, (eventType, filename) => {
          void eventType;
          const name = filename == null ? '' : String(filename);
          if (!name || name.startsWith('.tmp-')) return;
          if (name !== 'integrity-journal.jsonl') return;
          finalLeafObserved = true;
          tryInjectAfterRenameCommit();
        });

        const pollerStop = { stop: false };
        const poller = (async () => {
          const deadline = Date.now() + 5000;
          while (!pollerStop.stop && !injected && Date.now() < deadline) {
            tryInjectAfterRenameCommit();
            await new Promise((resolve) => setImmediate(resolve));
          }
        })();

        try {
          await assert.rejects(
            () => publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan),
            (error) => {
              // Prefer typed chain-broken; I/O classification also fail-closed (never success).
              if (error && error.code === ERROR_CODES.AUDIT_CHAIN_BROKEN) {
                return assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN, root);
              }
              if (error && error.code === ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR) {
                return assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR, root);
              }
              assert.fail(`unexpected publish outcome code: ${error && error.code}`);
              return false;
            },
          );
          assert.equal(injected, true, 'runtime post-rename injection must have fired');
          assert.equal(await readFile(abs, 'utf8'), injectedBytes);
          // Watcher arming is part of the preferred path; poller is the deterministic commit gate.
          void finalLeafObserved;
        } finally {
          pollerStop.stop = true;
          watcher.close();
          await Promise.race([
            poller,
            new Promise((resolve) => setTimeout(resolve, 50)),
          ]);
        }
      });
    });
  });

  it('unlocked append does not double-enqueue (source + runtime nested reject)', async () => {
    const source = await readFile(new URL('../src/audit-integrity-journal.js', import.meta.url), 'utf8');
    // Unlocked path must not call enqueue.
    const unlockedStart = source.indexOf('export async function appendAuditIntegrityEventUnlocked');
    const unlockedEnd = source.indexOf('export async function appendAuditIntegrityEvent', unlockedStart + 10);
    const unlockedBody = source.slice(unlockedStart, unlockedEnd);
    assert.equal(unlockedBody.includes('enqueueAuditIntegrityWriteTask'), false);
    assert.ok(unlockedBody.includes('planAuditIntegrityEventLinkUnlocked'));
    assert.ok(unlockedBody.includes('publishPlannedAuditIntegrityEventLinkAtomicUnlocked'));

    await withTempRoot('c1-no-double-enq', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEventUnlocked,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const receipt = await withLease(root, async (resolvedRoot, lease) => (
        appendAuditIntegrityEventUnlocked(resolvedRoot, lease, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        })
      ));
      assert.equal(receipt.state, 'appended');
    });
  });
});

// ── V1.37 C2: public journal-only state-absent gate ─────────────────────

function dualWriteStateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

async function loadDualWriteStateModule() {
  return import('../src/audit-integrity-dual-write-state.js');
}

function assertDualWriteBlocked(error, rootHint) {
  assert.equal(error.name, 'AuditIntegrityDualWriteError');
  assert.equal(error.code, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED);
  assert.equal(error.message, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
  }
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('integrity-dual-write-state'));
  return true;
}

function buildGateIdleState() {
  const emptySha = createHash('sha256').update('').digest('hex');
  return {
    schemaVersion: 1,
    status: 'idle',
    generationId: GENERATION_ID,
    journal: {
      recordCount: 1,
      headDigest: independentOpenLinkDigest(GENERATION_ID),
      rawByteLength: 0,
      rawSha256: emptySha,
    },
    events: {
      present: false,
      byteLength: 0,
      sha256: emptySha,
      strictRecordCount: 0,
    },
    lastTransactionId: null,
    lastPayloadDigest: null,
    lastSequence: null,
  };
}

function buildGatePreparedState() {
  const emptySha = createHash('sha256').update('').digest('hex');
  const event = {
    id: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-07-19T00:00:00.000Z',
    type: 'api.test',
  };
  const eventLineUtf8 = `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
  // payloadDigest via independent domain formula matching shared SoT (tests may use either).
  const payloadDigest = independentPayloadDigest(event);
  const preHead = independentOpenLinkDigest(GENERATION_ID);
  const postHead = 'c'.repeat(64);
  return {
    schemaVersion: 1,
    status: 'prepared',
    transactionId: '11111111-1111-4111-8111-111111111111',
    generationId: GENERATION_ID,
    retention: null,
    event,
    payloadDigest,
    eventLineUtf8,
    journal: {
      pre: {
        recordCount: 1,
        headDigest: preHead,
        rawByteLength: 240,
        rawSha256: 'b'.repeat(64),
      },
      post: {
        recordCount: 2,
        headDigest: postHead,
        rawByteLength: 480,
        rawSha256: 'd'.repeat(64),
        sequence: 1,
        linkDigest: postHead,
        previousLinkDigest: preHead,
      },
    },
    events: {
      pre: {
        present: true,
        byteLength: 10,
        sha256: 'e'.repeat(64),
        strictRecordCount: 1,
      },
      post: {
        present: true,
        byteLength: 80,
        sha256: 'f'.repeat(64),
        strictRecordCount: 2,
      },
    },
  };
}

describe('V1.37 C2 public journal-only state-absent gate', () => {
  async function withLease(root, fn) {
    const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
    const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
    const resolvedRoot = await assertSafeDataRoot(root);
    return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
  }

  it('C2-1: state missing → public init still works (cold absent; no state create)', async () => {
    await withTempRoot('c2-init-miss', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const receipt = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      assert.equal(receipt.state, 'initialized');
      await assert.rejects(() => access(dualWriteStateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('C2-2: state missing → public append still works (no state create)', async () => {
    await withTempRoot('c2-app-miss', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(receipt.state, 'appended');
      await assert.rejects(() => access(dualWriteStateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('C2-3: idle state → public init DIRECT_MUTATION_BLOCKED; journal bytes unchanged', async () => {
    await withTempRoot('c2-init-idle', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGateIdleState());
      });
      const beforeState = await readFile(dualWriteStateAbs(root));
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        (e) => assertDualWriteBlocked(e, root),
      );
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
      assert.deepEqual(await readFile(dualWriteStateAbs(root)), beforeState);
    });
  });

  it('C2-4: idle state → public append blocked; journal bytes unchanged', async () => {
    await withTempRoot('c2-app-idle', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const beforeJournal = await readFile(journalAbs(root));
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGateIdleState());
      });
      const beforeState = await readFile(dualWriteStateAbs(root));
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.deepEqual(await readFile(dualWriteStateAbs(root)), beforeState);
    });
  });

  it('C2-5: prepared state → public init blocked; no recover', async () => {
    await withTempRoot('c2-init-prep', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGatePreparedState());
      });
      const beforeState = await readFile(dualWriteStateAbs(root), 'utf8');
      assert.ok(beforeState.includes('"status":"prepared"'));
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.equal(await readFile(dualWriteStateAbs(root), 'utf8'), beforeState);
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
    });
  });

  it('C2-6: prepared state → public append blocked; no recover', async () => {
    await withTempRoot('c2-app-prep', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const beforeJournal = await readFile(journalAbs(root));
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGatePreparedState());
      });
      const beforeState = await readFile(dualWriteStateAbs(root), 'utf8');
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.equal(await readFile(dualWriteStateAbs(root), 'utf8'), beforeState);
      assert.ok(beforeState.includes('"status":"prepared"'));
    });
  });

  it('C2-7: invalid JSON state file → public init/append blocked; bytes unchanged', async () => {
    await withTempRoot('c2-badjson', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const beforeJournal = await readFile(journalAbs(root));
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dualWriteStateAbs(root), '{not-json', { mode: 0o600 });
      const beforeState = await readFile(dualWriteStateAbs(root));
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID_ALT }),
        (e) => assertDualWriteBlocked(e, root),
      );
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.deepEqual(await readFile(dualWriteStateAbs(root)), beforeState);
    });
  });

  it('C2-8: state symlink/dir → public init/append blocked; journal unchanged', async () => {
    await withTempRoot('c2-symdir', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const beforeJournal = await readFile(journalAbs(root));

      // Directory leaf.
      await mkdir(dualWriteStateAbs(root), { recursive: true });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      await rm(dualWriteStateAbs(root), { recursive: true, force: true });

      // Symlink leaf.
      const outside = await mkdtempSafe('c2-sym-out');
      try {
        const target = join(outside, 'state.json');
        await writeFile(target, 'x', { mode: 0o600 });
        await symlink(target, dualWriteStateAbs(root));
        await assert.rejects(
          () => appendAuditIntegrityEvent(root, {
            generationId: GENERATION_ID,
            event: { ...EVENT_A },
          }),
          (e) => assertDualWriteBlocked(e, root),
        );
        assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('C2-9: source/runtime public init/append enqueue→gate→unlocked (not gate-before-enqueue)', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const source = await rf(new URL('../src/audit-integrity-journal.js', import.meta.url), 'utf8');

    const initIdx = source.indexOf('export async function initializeAuditIntegrityJournal');
    const initBody = source.slice(initIdx, source.indexOf('export function computeAuditIntegrityEventPayloadDigest', initIdx));
    assert.ok(initBody.includes('enqueueAuditIntegrityWriteTask'));
    assert.ok(initBody.includes('assertDualWriteStateAbsentUnlocked'));
    assert.ok(initBody.includes('initializeAuditIntegrityJournalUnlocked'));
    // Gate must appear after enqueue callback start, not before return enqueue.
    const enqueuePos = initBody.indexOf('return enqueueAuditIntegrityWriteTask');
    const gatePos = initBody.indexOf('assertDualWriteStateAbsentUnlocked');
    assert.ok(enqueuePos >= 0 && gatePos > enqueuePos, 'gate must be inside enqueue callback');

    const appendIdx = source.indexOf('export async function appendAuditIntegrityEvent(');
    const appendBody = source.slice(appendIdx, appendIdx + 2200);
    const aEnq = appendBody.indexOf('return enqueueAuditIntegrityWriteTask');
    const aGate = appendBody.indexOf('assertDualWriteStateAbsentUnlocked');
    assert.ok(aEnq >= 0 && aGate > aEnq, 'append gate must be inside enqueue callback');
    assert.ok(appendBody.includes('appendAuditIntegrityEventUnlocked'));

    // Unlocked primitives must not gate.
    const unlockedInitIdx = source.indexOf('export async function initializeAuditIntegrityJournalUnlocked');
    const unlockedInitBody = source.slice(unlockedInitIdx, unlockedInitIdx + 1200);
    assert.equal(unlockedInitBody.includes('assertDualWriteStateAbsentUnlocked'), false);
    const unlockedAppendIdx = source.indexOf('export async function appendAuditIntegrityEventUnlocked');
    const unlockedAppendBody = source.slice(unlockedAppendIdx, unlockedAppendIdx + 800);
    assert.equal(unlockedAppendBody.includes('assertDualWriteStateAbsentUnlocked'), false);
  });

  it('C2-10: gate runs under active lease; lease proves critical section only', async () => {
    await withTempRoot('c2-lease', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournalModule();
      const { assertAuditIntegrityWriteLease } = await import('../src/audit-integrity-write-queue.js');
      const stateMod = await loadDualWriteStateModule();
      // Runtime: public init with missing state succeeds (lease acquired inside queue).
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      // Gate under lease with occupied rejects dual-write blocked (not SafeDataFileError).
      await withLease(root, async (resolvedRoot, lease) => {
        assertAuditIntegrityWriteLease(resolvedRoot, lease);
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGateIdleState());
        await assert.rejects(
          () => stateMod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteBlocked(e, root),
        );
      });
    });
  });

  it('C2-11: concurrency canary — occupied-first blocks; public-first then occupy; never journal write after occupied', async () => {
    await withTempRoot('c2-canary', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();
      const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);

      // Order A: occupy first via shared queue, then public append rejects; journal never created.
      const occupyFirst = enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGateIdleState());
      });
      const publicAfter = occupyFirst.then(() => appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      }));
      await assert.rejects(publicAfter, (e) => assertDualWriteBlocked(e, root));
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });

      // Fresh root for order B.
    });

    await withTempRoot('c2-canary-b', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();
      const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));
      const resolvedRoot = await assertSafeDataRoot(root);

      // Hold queue: public append joins after block starts; then occupy after public completes.
      let releaseBlock;
      const blockP = new Promise((resolve) => { releaseBlock = resolve; });
      const hold = enqueueAuditIntegrityWriteTask(resolvedRoot, async () => {
        await blockP;
      });

      const publicP = appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      // Let public join the queue behind hold.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const occupyAfter = publicP.then(() => enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGateIdleState());
      }));

      releaseBlock();
      await hold;
      const receipt = await publicP;
      assert.equal(receipt.state, 'appended');
      await occupyAfter;
      const afterJournal = await readFile(journalAbs(root));
      assert.notDeepEqual(afterJournal, before);
      // After occupied, further public mutation blocked; journal frozen.
      const frozen = await readFile(journalAbs(root));
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_B },
        }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), frozen);
    });
  });

  it('C2-12: gate is real path occupancy (source bans always-allow/TODO/stub)', async () => {
    const source = await readFile(
      new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
      'utf8',
    );
    assert.ok(source.includes('assertDualWriteStateAbsentUnlocked'));
    assert.ok(source.includes('safeReadText') || source.includes('ENOENT'));
    for (const ban of ['always-allow', 'alwaysAllow', 'TODO', 'skeleton', 'write-only']) {
      assert.equal(source.includes(ban), false);
    }
  });

  it('C2-13: any state file only from tests; C2 production path does not write state', async () => {
    await withTempRoot('c2-no-create', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      await assert.rejects(() => access(dualWriteStateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('C2-14: hand publish idle|prepared|invalid|unsafe each block public init/append', async () => {
    await withTempRoot('c2-matrix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      const stateMod = await loadDualWriteStateModule();

      async function expectBlocked(label) {
        await assert.rejects(
          () => initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID }),
          (e) => assertDualWriteBlocked(e, root),
          label,
        );
        await assert.rejects(
          () => appendAuditIntegrityEvent(root, {
            generationId: GENERATION_ID,
            event: { ...EVENT_A },
          }),
          (e) => assertDualWriteBlocked(e, root),
          label,
        );
      }

      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGateIdleState());
      });
      await expectBlocked('idle');
      await rm(dualWriteStateAbs(root), { force: true });

      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildGatePreparedState());
      });
      await expectBlocked('prepared');
      await rm(dualWriteStateAbs(root), { force: true });

      await writeFile(dualWriteStateAbs(root), 'nope', { mode: 0o600 });
      await expectBlocked('invalid');
      await rm(dualWriteStateAbs(root), { force: true });

      await mkdir(dualWriteStateAbs(root), { recursive: true });
      await expectBlocked('dir');
    });
  });

  it('C2-15: state module has full load/parse/publish (not write-only fake green)', async () => {
    await withTempRoot('c2-full', async (root) => {
      const stateMod = await loadDualWriteStateModule();
      const idle = buildGateIdleState();
      const parsed = stateMod.parseAuditIntegrityDualWriteStateText(`${JSON.stringify(idle)}\n`);
      assert.equal(parsed.status, 'idle');
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle);
        const loaded = await stateMod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded.status, 'idle');
        await assert.rejects(
          () => stateMod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteBlocked(e, root),
        );
      });
    });
  });

  it('C2-16: oversize state file blocks public mutation; journal unchanged', async () => {
    await withTempRoot('c2-over', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournalModule();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const beforeJournal = await readFile(journalAbs(root));
      await writeFile(dualWriteStateAbs(root), `${'z'.repeat(65537)}\n`, { mode: 0o600 });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...EVENT_A },
        }),
        (e) => assertDualWriteBlocked(e, root),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
    });
  });
});

// ── V1.43 Task 1: journal v2 homogeneous generation contract (J1–J6) ────

const GENERATION_ID_V2 = '00112233445566778899aabbccddeeff';
const DOMAIN_V2_GENERATION_OPEN = 'linke.audit-integrity-journal.v2.generation-open\u0000';
const DOMAIN_V2_EVENT_LINK = 'linke.audit-integrity-journal.v2.event-link\u0000';

/** Fixed strict-canonical rotation event vector (design §9 exact field set). */
const ROTATION_EVENT_V2 = Object.freeze({
  id: '55555555-5555-4555-8555-555555555555',
  createdAt: '2026-07-24T00:00:00.000Z',
  type: 'audit-integrity-rotation',
  outcome: 'committed',
  operation: 'generation-transition',
  message: 'audit integrity generation rotation committed',
});

/** Fixed 64-hex stand-ins for the archived v1 head and the archive manifest digest. */
const ARCHIVED_V1_HEAD_DIGEST = createHash('sha256')
  .update(`fixture-archived-v1-head:${GENERATION_ID}`)
  .digest('hex');
const ARCHIVE_MANIFEST_DIGEST = createHash('sha256')
  .update(`fixture-archive-manifest:${GENERATION_ID}:${GENERATION_ID_V2}`)
  .digest('hex');

/** Fixed pure/sync v2 builder options; the builder performs no filesystem I/O. */
const FIXED_V2_OPTIONS = Object.freeze({
  generationId: GENERATION_ID_V2,
  previousGenerationId: GENERATION_ID,
  previousHeadDigest: ARCHIVED_V1_HEAD_DIGEST,
  archiveManifestDigest: ARCHIVE_MANIFEST_DIGEST,
  rotationEvent: ROTATION_EVENT_V2,
});

const V2_OPEN_RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'recordKind',
  'generationId',
  'previousGenerationId',
  'previousHeadDigest',
  'archiveManifestDigest',
  'sequence',
  'previousLinkDigest',
  'payloadDigest',
  'linkDigest',
]);

const V2_GENERATION_BINDING_KEYS = Object.freeze([
  'previousGenerationId',
  'previousHeadDigest',
  'archiveManifestDigest',
]);

/**
 * v2 symbols are not exported pre-implementation: reach them only through the
 * module namespace so RED is a missing-API assertion, never a module-load failure.
 */
function assertV2ApiPresent(mod) {
  assert.equal(typeof mod.buildAuditIntegrityV2GenerationImage, 'function');
  assert.equal(typeof mod.verifyAuditIntegrityJournalText, 'function');
}

/** Independent v2 open-link digest (does not import private helpers from the module under test). */
function independentV2OpenDigest(record) {
  return createHash('sha256')
    .update(
      DOMAIN_V2_GENERATION_OPEN
        + record.generationId
        + '\u0000'
        + record.previousGenerationId
        + '\u0000'
        + record.previousHeadDigest
        + '\u0000'
        + record.archiveManifestDigest
        + '\u0000'
        + '0'
        + '\u0000'
        + 'null'
        + '\u0000'
        + 'null',
    )
    .digest('hex');
}

/** Independent v2 event-link digest: v2 domain over the shared 7-key preimage order. */
function independentV2EventLinkDigest({ generationId, sequence, previousLinkDigest, payloadDigest }) {
  return createHash('sha256')
    .update(
      DOMAIN_V2_EVENT_LINK
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

/** Exact 10-key canonical v2 open JSON line (no trailing newline). */
function canonicalV2OpenLine(record) {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    recordKind: record.recordKind,
    generationId: record.generationId,
    previousGenerationId: record.previousGenerationId,
    previousHeadDigest: record.previousHeadDigest,
    archiveManifestDigest: record.archiveManifestDigest,
    sequence: record.sequence,
    previousLinkDigest: record.previousLinkDigest,
    payloadDigest: record.payloadDigest,
    linkDigest: record.linkDigest,
  });
}

describe('V1.43 Task 1 journal v2 homogeneous generation contract (J1–J6)', () => {
  it('J1 v1 canonical vectors and public receipts remain byte-for-byte unchanged', async () => {
    await withTempRoot('v2-j1-v1-vectors', async (root) => {
      const mod = await loadJournalModule();
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = mod;

      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      assert.deepEqual(init, {
        state: 'initialized',
        generationId: GENERATION_ID,
        recordCount: 1,
        headDigest: independentOpenLinkDigest(GENERATION_ID),
      });
      assert.equal(Object.keys(init).join(','), 'state,generationId,recordCount,headDigest');

      const openLine = expectedOpenLine(GENERATION_ID);
      assert.equal(Buffer.byteLength(openLine, 'utf8'), 240);
      assert.equal(await readFile(journalAbs(root), 'utf8'), `${openLine}\n`);

      const expectedPayload = independentPayloadDigest(EVENT_A);
      const expectedLink = independentEventLinkDigest({
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: init.headDigest,
        payloadDigest: expectedPayload,
      });
      const appended = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.deepEqual(appended, {
        state: 'appended',
        generationId: GENERATION_ID,
        sequence: 1,
        recordCount: 2,
        headDigest: expectedLink,
        payloadDigest: expectedPayload,
      });
      assert.equal(
        Object.keys(appended).join(','),
        'state,generationId,sequence,recordCount,headDigest,payloadDigest',
      );

      const eventLine = canonicalRecordLine({
        schemaVersion: 1,
        recordKind: 'event-link',
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: init.headDigest,
        payloadDigest: expectedPayload,
        linkDigest: expectedLink,
      });
      const raw = await readFile(journalAbs(root), 'utf8');
      assert.equal(raw, `${openLine}\n${eventLine}\n`);

      const verified = await verifyAuditIntegrityJournalFile(root);
      assert.deepEqual(verified, {
        state: 'verified',
        generationId: GENERATION_ID,
        recordCount: 2,
        headDigest: expectedLink,
      });
      assert.equal(Object.keys(verified).join(','), 'state,generationId,recordCount,headDigest');

      // v1 raw re-verified through the v2-aware text verifier stays result-compatible:
      // same identity fields, schemaVersion 1, and no generationBinding (v2 open only).
      assertV2ApiPresent(mod);
      const text = mod.verifyAuditIntegrityJournalText(raw);
      assert.equal(text.schemaVersion, 1);
      assert.equal(text.generationId, verified.generationId);
      assert.equal(text.recordCount, verified.recordCount);
      assert.equal(text.headDigest, verified.headDigest);
      assert.equal(
        Object.prototype.hasOwnProperty.call(text, 'generationBinding'),
        false,
      );
    });
  });

  it('J2 v2 generation-open has exact ten keys, 477 bytes, and independent digest', async () => {
    const mod = await loadJournalModule();
    assertV2ApiPresent(mod);
    assert.equal(mod.AUDIT_INTEGRITY_JOURNAL_V2_OPEN_MAX_LINE_BYTES, 477);

    const built = mod.buildAuditIntegrityV2GenerationImage(FIXED_V2_OPTIONS);
    assert.equal(Object.isFrozen(built), true);
    assert.deepEqual(Object.keys(built), [
      'rawText',
      'schemaVersion',
      'generationId',
      'recordCount',
      'headDigest',
      'eventPayloadDigest',
      'rawByteLength',
      'rawSha256',
      'generationBinding',
    ]);
    assert.equal(built.schemaVersion, 2);
    assert.equal(built.generationId, GENERATION_ID_V2);
    assert.equal(built.recordCount, 2);
    assert.equal(built.rawByteLength, Buffer.byteLength(built.rawText, 'utf8'));
    assert.equal(built.rawSha256, createHash('sha256').update(built.rawText).digest('hex'));
    assert.deepEqual(built.generationBinding, {
      previousGenerationId: GENERATION_ID,
      previousHeadDigest: ARCHIVED_V1_HEAD_DIGEST,
      archiveManifestDigest: ARCHIVE_MANIFEST_DIGEST,
    });
    assert.deepEqual(Object.keys(built.generationBinding), [...V2_GENERATION_BINDING_KEYS]);
    assert.equal(Object.isFrozen(built.generationBinding), true);

    const [openLine] = built.rawText.trimEnd().split('\n');
    const open = JSON.parse(openLine);
    assert.deepEqual(Object.keys(open), [...V2_OPEN_RECORD_KEYS]);
    assert.equal(open.schemaVersion, 2);
    assert.equal(open.recordKind, 'generation-open');
    assert.equal(open.generationId, GENERATION_ID_V2);
    assert.equal(open.previousGenerationId, GENERATION_ID);
    assert.equal(open.previousHeadDigest, ARCHIVED_V1_HEAD_DIGEST);
    assert.equal(open.archiveManifestDigest, ARCHIVE_MANIFEST_DIGEST);
    assert.equal(open.sequence, 0);
    assert.equal(open.previousLinkDigest, null);
    assert.equal(open.payloadDigest, null);
    assert.equal(open.linkDigest, independentV2OpenDigest(open));
    assert.equal(openLine, canonicalV2OpenLine(open));
    assert.equal(Buffer.byteLength(openLine, 'utf8'), 477);
  });

  it('J3 v2 event-link uses the v2 domain and verifies as a homogeneous generation', async () => {
    const mod = await loadJournalModule();
    assertV2ApiPresent(mod);

    const built = mod.buildAuditIntegrityV2GenerationImage(FIXED_V2_OPTIONS);
    assert.ok(built.rawText.endsWith('\n'));
    const lines = built.rawText.trimEnd().split('\n');
    assert.equal(lines.length, 2);

    const open = JSON.parse(lines[0]);
    const event = JSON.parse(lines[1]);
    assert.deepEqual(Object.keys(event), [...OPEN_RECORD_KEYS]);
    assert.equal(event.schemaVersion, 2);
    assert.equal(event.recordKind, 'event-link');
    assert.equal(event.generationId, GENERATION_ID_V2);
    assert.equal(event.sequence, 1);
    assert.equal(event.previousLinkDigest, open.linkDigest);

    const expectedPayload = independentPayloadDigest(ROTATION_EVENT_V2);
    assert.equal(event.payloadDigest, expectedPayload);
    assert.equal(built.eventPayloadDigest, expectedPayload);
    const expectedLink = independentV2EventLinkDigest({
      generationId: event.generationId,
      sequence: event.sequence,
      previousLinkDigest: event.previousLinkDigest,
      payloadDigest: event.payloadDigest,
    });
    assert.equal(event.linkDigest, expectedLink);
    // Domain separation is decisive: identical fields under the v1 domain never match.
    assert.notEqual(
      event.linkDigest,
      independentEventLinkDigest({
        generationId: event.generationId,
        sequence: event.sequence,
        previousLinkDigest: event.previousLinkDigest,
        payloadDigest: event.payloadDigest,
      }),
    );
    assert.equal(lines[1], canonicalRecordLine(event));
    assert.ok(Buffer.byteLength(lines[1], 'utf8') <= 374);
    assert.equal(built.headDigest, expectedLink);

    const verified = mod.verifyAuditIntegrityJournalText(built.rawText);
    assert.equal(verified.schemaVersion, 2);
    assert.equal(verified.generationId, GENERATION_ID_V2);
    assert.equal(verified.recordCount, 2);
    assert.equal(verified.headDigest, built.headDigest);
    assert.deepEqual(verified.generationBinding, built.generationBinding);
    assert.equal(Object.isFrozen(verified.generationBinding), true);
  });

  it('J4 v1 open followed by v2 event-link is audit-chain-broken', async () => {
    const mod = await loadJournalModule();
    assertV2ApiPresent(mod);

    const openLine = expectedOpenLine(GENERATION_ID);
    const openLink = independentOpenLinkDigest(GENERATION_ID);
    const payloadDigest = 'c'.repeat(64);
    const v2EventLine = canonicalRecordLine({
      schemaVersion: 2,
      recordKind: 'event-link',
      generationId: GENERATION_ID,
      sequence: 1,
      previousLinkDigest: openLink,
      payloadDigest,
      linkDigest: independentV2EventLinkDigest({
        generationId: GENERATION_ID,
        sequence: 1,
        previousLinkDigest: openLink,
        payloadDigest,
      }),
    });
    const mixedRaw = `${openLine}\n${v2EventLine}\n`;
    assert.throws(
      () => mod.verifyAuditIntegrityJournalText(mixedRaw),
      (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN),
    );
  });

  it('J5 v2 open followed by v1 event-link is audit-chain-broken', async () => {
    const mod = await loadJournalModule();
    assertV2ApiPresent(mod);

    const built = mod.buildAuditIntegrityV2GenerationImage(FIXED_V2_OPTIONS);
    const [openLine] = built.rawText.trimEnd().split('\n');
    const open = JSON.parse(openLine);
    const payloadDigest = 'd'.repeat(64);
    const v1EventLine = canonicalRecordLine({
      schemaVersion: 1,
      recordKind: 'event-link',
      generationId: GENERATION_ID_V2,
      sequence: 1,
      previousLinkDigest: open.linkDigest,
      payloadDigest,
      linkDigest: independentEventLinkDigest({
        generationId: GENERATION_ID_V2,
        sequence: 1,
        previousLinkDigest: open.linkDigest,
        payloadDigest,
      }),
    });
    const mixedRaw = `${openLine}\n${v1EventLine}\n`;
    assert.throws(
      () => mod.verifyAuditIntegrityJournalText(mixedRaw),
      (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN),
    );
  });

  it('J6 v1 archived head binds a separately built v2 live generation image', async () => {
    await withTempRoot('v2-j6-cross-generation', async (root) => {
      const mod = await loadJournalModule();
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = mod;
      assertV2ApiPresent(mod);

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const appended = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const archivedRaw = await readFile(journalAbs(root), 'utf8');
      const archivedVerify = await verifyAuditIntegrityJournalFile(root);

      // v1 archive verified through the v2-aware text verifier stays result-compatible.
      const archivedText = mod.verifyAuditIntegrityJournalText(archivedRaw);
      assert.equal(archivedText.schemaVersion, 1);
      assert.equal(archivedText.generationId, archivedVerify.generationId);
      assert.equal(archivedText.recordCount, archivedVerify.recordCount);
      assert.equal(archivedText.headDigest, archivedVerify.headDigest);
      assert.equal(
        Object.prototype.hasOwnProperty.call(archivedText, 'generationBinding'),
        false,
      );

      const built = mod.buildAuditIntegrityV2GenerationImage({
        generationId: GENERATION_ID_V2,
        previousGenerationId: GENERATION_ID,
        previousHeadDigest: archivedVerify.headDigest,
        archiveManifestDigest: ARCHIVE_MANIFEST_DIGEST,
        rotationEvent: ROTATION_EVENT_V2,
      });
      assert.notEqual(built.rawText, archivedRaw);
      assert.notEqual(built.headDigest, archivedVerify.headDigest);

      const [openLine] = built.rawText.trimEnd().split('\n');
      const open = JSON.parse(openLine);
      assert.equal(open.previousGenerationId, GENERATION_ID);
      assert.equal(open.previousHeadDigest, archivedVerify.headDigest);
      assert.equal(open.previousHeadDigest, appended.headDigest);
      assert.equal(open.linkDigest, independentV2OpenDigest(open));

      const live = mod.verifyAuditIntegrityJournalText(built.rawText);
      assert.equal(live.schemaVersion, 2);
      assert.equal(live.generationId, GENERATION_ID_V2);
      assert.equal(live.recordCount, 2);
      assert.equal(live.headDigest, built.headDigest);
      assert.deepEqual(live.generationBinding, {
        previousGenerationId: GENERATION_ID,
        previousHeadDigest: archivedVerify.headDigest,
        archiveManifestDigest: ARCHIVE_MANIFEST_DIGEST,
      });
      assert.equal(Object.isFrozen(live.generationBinding), true);

      // Cross-generation binding is by digest only: archived v1 bytes stay untouched.
      assert.equal(await readFile(journalAbs(root), 'utf8'), archivedRaw);
    });
  });
});

// ── Task 1 review regression: full-file byte envelope in the public text verifier ────

describe('Task 1 review full-file byte envelope', () => {
  it('Task 1 review full-file byte envelope gates before structural parsing', async () => {
    const mod = await loadJournalModule();
    assertV2ApiPresent(mod);
    const maxBytes = mod.AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES;
    assert.equal(maxBytes, 1_572_864);

    // Non-string input stays chain-broken: the typeof gate runs first.
    assert.throws(
      () => mod.verifyAuditIntegrityJournalText(null),
      (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN),
    );

    // Exactly MAX+1 ASCII bytes without trailing newline: size overlimit is
    // io-error (never bounds-exceeded, never chain-broken).
    const overAscii = 'a'.repeat(maxBytes + 1);
    assert.equal(Buffer.byteLength(overAscii, 'utf8'), maxBytes + 1);
    assert.throws(
      () => mod.verifyAuditIntegrityJournalText(overAscii),
      (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR),
    );

    // Exactly MAX+1 newline bytes: still io-error — the size gate fires before
    // any trailing-newline check, slice, split, or per-line bound.
    const overNewlines = '\n'.repeat(maxBytes + 1);
    assert.equal(Buffer.byteLength(overNewlines, 'utf8'), maxBytes + 1);
    assert.throws(
      () => mod.verifyAuditIntegrityJournalText(overNewlines),
      (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR),
    );

    // Exactly MAX ASCII bytes without trailing newline: not size-overlimit, so
    // structural verify owns the failure and it stays chain-broken.
    const exactAscii = 'a'.repeat(maxBytes);
    assert.equal(Buffer.byteLength(exactAscii, 'utf8'), maxBytes);
    assert.throws(
      () => mod.verifyAuditIntegrityJournalText(exactAscii),
      (error) => assertIntegrityError(error, ERROR_CODES.AUDIT_CHAIN_BROKEN),
    );
  });
});
