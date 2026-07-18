/**
 * V1.37 C2: dual-write state schema / parser / publish / path-occupancy absent gate.
 * Real full module contract (not skeleton / write-only / always-allow).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, watch } from 'node:fs';
import { readFile, writeFile, mkdir, symlink, rm, lstat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import {
  projectStrictCanonicalSanitizedEvent,
  stringifyStrictCanonicalSanitizedEvent,
  computeAuditIntegrityEventPayloadDigest,
} from '../src/audit-event-schema.js';

const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const TX_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_C = 'c'.repeat(64);
const HEX64_D = 'd'.repeat(64);
const HEX64_E = 'e'.repeat(64);
const HEX64_F = 'f'.repeat(64);
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const STRICT_EVENT = Object.freeze({
  id: EVENT_ID,
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
});

async function mkdtempSafe(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), `linke-adws-${prefix}-`));
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtempSafe(prefix);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

async function loadStateModule() {
  return import('../src/audit-integrity-dual-write-state.js');
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function assertDualWriteError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityDualWriteError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  // Path-free: never embed filesystem path fragments (code value itself may contain
  // the relative path token as a kebab registry id — that is not a path leak).
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('/var/'));
  assert.ok(!error.message.includes('/private/'));
  assert.ok(!error.message.includes('/tmp/'));
  assert.ok(!error.message.includes('Users/'));
  return true;
}

function fingerprint4(overrides = {}) {
  return {
    recordCount: 1,
    headDigest: HEX64_A,
    rawByteLength: 0,
    rawSha256: HEX64_B,
    ...overrides,
  };
}

function eventsFp(overrides = {}) {
  return {
    present: false,
    byteLength: 0,
    sha256: EMPTY_SHA256,
    strictRecordCount: 0,
    ...overrides,
  };
}

function buildIdle(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'idle',
    generationId: GENERATION_ID,
    journal: fingerprint4(),
    events: eventsFp(),
    lastTransactionId: null,
    lastPayloadDigest: null,
    lastSequence: null,
    ...overrides,
  };
}

function buildPrepared(overrides = {}) {
  const event = projectStrictCanonicalSanitizedEvent({ ...STRICT_EVENT });
  const eventLineUtf8 = `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
  const payloadDigest = computeAuditIntegrityEventPayloadDigest(event);
  const preHead = HEX64_A;
  const postHead = HEX64_C;
  return {
    schemaVersion: 1,
    status: 'prepared',
    transactionId: TX_ID,
    generationId: GENERATION_ID,
    retention: null,
    event,
    payloadDigest,
    eventLineUtf8,
    journal: {
      pre: fingerprint4({
        recordCount: 1,
        headDigest: preHead,
        rawByteLength: 240,
        rawSha256: HEX64_B,
      }),
      post: {
        recordCount: 2,
        headDigest: postHead,
        rawByteLength: 480,
        rawSha256: HEX64_D,
        sequence: 1,
        linkDigest: postHead,
        previousLinkDigest: preHead,
      },
    },
    events: {
      pre: eventsFp({
        present: true,
        byteLength: 10,
        sha256: HEX64_E,
        strictRecordCount: 1,
      }),
      post: eventsFp({
        present: true,
        byteLength: 80,
        sha256: HEX64_F,
        strictRecordCount: 2,
      }),
    },
    ...overrides,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function reorderKeys(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

// ── Constants / exports ────────────────────────────────────────────────

describe('dual-write state constants and exports (C2)', () => {
  it('1. exports path, maxBytes 65536, Error class, parser/load/publish/gate', async () => {
    const mod = await loadStateModule();
    assert.equal(
      mod.AUDIT_INTEGRITY_DUAL_WRITE_STATE_RELATIVE_PATH,
      'audit/integrity-dual-write-state.json',
    );
    assert.equal(mod.AUDIT_DUAL_WRITE_STATE_MAX_BYTES, 65536);
    assert.equal(typeof mod.AuditIntegrityDualWriteError, 'function');
    assert.equal(typeof mod.parseAuditIntegrityDualWriteStateText, 'function');
    assert.equal(typeof mod.loadDualWriteStateUnlocked, 'function');
    assert.equal(typeof mod.publishDualWriteStateUnlocked, 'function');
    assert.equal(typeof mod.assertDualWriteStateAbsentUnlocked, 'function');
    assert.equal(typeof mod.buildSuccessfulIdleLastFieldsFromPrepared, 'function');
  });
});

// ── Idle / prepared parse + publish roundtrip ──────────────────────────

describe('dual-write state idle/prepared roundtrip', () => {
  it('2. legal idle publish+load roundtrip; mode 0600; trailing newline; frozen keys', async () => {
    await withTempRoot('idle-rt', async (root) => {
      const mod = await loadStateModule();
      const idle = buildIdle();
      await withLease(root, async (resolvedRoot, lease) => {
        await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle);
        const loaded = await mod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded.status, 'idle');
        assert.deepEqual(loaded, mod.parseAuditIntegrityDualWriteStateText(
          await readFile(stateAbs(root), 'utf8'),
        ));
        assert.ok(Object.isFrozen(loaded));
        assert.ok(Object.isFrozen(loaded.journal));
        assert.ok(Object.isFrozen(loaded.events));
        assert.deepEqual(Object.keys(loaded), [
          'schemaVersion', 'status', 'generationId', 'journal', 'events',
          'lastTransactionId', 'lastPayloadDigest', 'lastSequence',
        ]);
        assert.deepEqual(Object.keys(loaded.journal), [
          'recordCount', 'headDigest', 'rawByteLength', 'rawSha256',
        ]);
        assert.deepEqual(Object.keys(loaded.events), [
          'present', 'byteLength', 'sha256', 'strictRecordCount',
        ]);
      });
      const raw = await readFile(stateAbs(root), 'utf8');
      assert.ok(raw.endsWith('\n'));
      assert.equal(raw.endsWith('\n\n'), false);
      const st = await lstat(stateAbs(root));
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  it('3. legal prepared retention=null publish+load roundtrip', async () => {
    await withTempRoot('prep-null', async (root) => {
      const mod = await loadStateModule();
      const prepared = buildPrepared({ retention: null });
      await withLease(root, async (resolvedRoot, lease) => {
        await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);
        const loaded = await mod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded.status, 'prepared');
        assert.equal(loaded.retention, null);
        assert.deepEqual(Object.keys(loaded), [
          'schemaVersion', 'status', 'transactionId', 'generationId', 'retention',
          'event', 'payloadDigest', 'eventLineUtf8', 'journal', 'events',
        ]);
        assert.deepEqual(Object.keys(loaded.journal.pre), [
          'recordCount', 'headDigest', 'rawByteLength', 'rawSha256',
        ]);
        assert.deepEqual(Object.keys(loaded.journal.post), [
          'recordCount', 'headDigest', 'rawByteLength', 'rawSha256',
          'sequence', 'linkDigest', 'previousLinkDigest',
        ]);
      });
    });
  });

  it('4. legal prepared retention={maxEvents:n} publish+load roundtrip', async () => {
    await withTempRoot('prep-ret', async (root) => {
      const mod = await loadStateModule();
      const prepared = buildPrepared({
        retention: { maxEvents: 2 },
        events: {
          pre: eventsFp({
            present: true, byteLength: 10, sha256: HEX64_E, strictRecordCount: 5,
          }),
          post: eventsFp({
            present: true, byteLength: 20, sha256: HEX64_F, strictRecordCount: 2,
          }),
        },
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);
        const loaded = await mod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.deepEqual(loaded.retention, { maxEvents: 2 });
        assert.equal(loaded.events.post.strictRecordCount, 2);
      });
    });
  });
});

// ── Hostile schema / key order ─────────────────────────────────────────

describe('dual-write state hostile schema', () => {
  it('5. wrong top-level key order → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle();
    const wrong = reorderKeys(idle, [
      'status', 'schemaVersion', 'generationId', 'journal', 'events',
      'lastTransactionId', 'lastPayloadDigest', 'lastSequence',
    ]);
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${JSON.stringify(wrong)}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('6. extra top-level key → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = { ...buildIdle(), extra: true };
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('7. missing top-level key → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle();
    delete idle.lastSequence;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('8. schemaVersion≠1 → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({ schemaVersion: 2 });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('9. status not idle|prepared → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({ status: 'recovering' });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('10. generationId not 32 hex → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({ generationId: 'not-hex-generation-id!!!!!' });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('11. digest not 64 hex → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({
      journal: fingerprint4({ headDigest: 'zzzz' }),
    });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('12. events.present=false but byteLength≠0 → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({
      events: eventsFp({ present: false, byteLength: 1, sha256: EMPTY_SHA256 }),
    });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('13. prepared.event extra field → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.event = { ...prepared.event, extra: 'nope' };
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('14. prepared.eventLineUtf8 ≠ strict stringify+\\n → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared({ eventLineUtf8: '{"id":"x"}\n' });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('15. prepared.eventLineUtf8 field order createdAt→id rejected', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    // Wrong key order in line while event object remains id→createdAt→type.
    const wrongLine =
      `{"createdAt":"${STRICT_EVENT.createdAt}","id":"${STRICT_EVENT.id}","type":"api.test"}\n`;
    prepared.eventLineUtf8 = wrongLine;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('16. prepared.payloadDigest ≠ shared SoT compute → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared({ payloadDigest: HEX64_A });
    assert.notEqual(prepared.payloadDigest, computeAuditIntegrityEventPayloadDigest(prepared.event));
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });
});

// ── Relationship invariants 10–26 ──────────────────────────────────────

describe('dual-write state relationship invariants', () => {
  it('17. prepared journal.post.recordCount ≠ pre+1 → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.journal.post.recordCount = 99;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('18. prepared journal.post.sequence ≠ pre.recordCount → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.journal.post.sequence = 0;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('19. prepared journal.post.previousLinkDigest ≠ pre.headDigest → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.journal.post.previousLinkDigest = HEX64_F;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('20. prepared journal.post.linkDigest ≠ post.headDigest → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.journal.post.linkDigest = HEX64_E;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('21. prepared events.post.present ≠ true → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.events.post.present = false;
    prepared.events.post.byteLength = 0;
    prepared.events.post.sha256 = EMPTY_SHA256;
    prepared.events.post.strictRecordCount = 0;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('22. retention null: events.post.strictRecordCount ≠ pre+1 → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared({ retention: null });
    prepared.events.post.strictRecordCount = prepared.events.pre.strictRecordCount + 2;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('23. retention enabled: events.post.strictRecordCount ≠ min(pre+1,maxEvents) → state-invalid', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared({
      retention: { maxEvents: 2 },
      events: {
        pre: eventsFp({
          present: true, byteLength: 10, sha256: HEX64_E, strictRecordCount: 5,
        }),
        post: eventsFp({
          present: true, byteLength: 20, sha256: HEX64_F, strictRecordCount: 3,
        }),
      },
    });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('24. idle last* partial null partial non-null → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({
      lastTransactionId: TX_ID,
      lastPayloadDigest: null,
      lastSequence: null,
    });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('25. idle last* all-non-null but lastSequence ≠ journal.recordCount-1 → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle({
      journal: fingerprint4({ recordCount: 3 }),
      lastTransactionId: TX_ID,
      lastPayloadDigest: HEX64_D,
      lastSequence: 0,
    });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('26. idle last* all-null legal (bootstrap shape)', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle();
    const parsed = mod.parseAuditIntegrityDualWriteStateText(`${JSON.stringify(idle)}\n`);
    assert.equal(parsed.lastTransactionId, null);
    assert.equal(parsed.lastPayloadDigest, null);
    assert.equal(parsed.lastSequence, null);
  });

  it('27. successful idle last* helper from prepared: tx/payloadDigest/post.sequence', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    const last = mod.buildSuccessfulIdleLastFieldsFromPrepared(prepared);
    assert.equal(last.lastTransactionId, prepared.transactionId);
    assert.equal(last.lastPayloadDigest, prepared.payloadDigest);
    assert.equal(last.lastSequence, prepared.journal.post.sequence);
  });

  it('28. C2 lock: all-non-null last* ⇒ lastSequence === journal.recordCount-1 (parser)', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    const last = mod.buildSuccessfulIdleLastFieldsFromPrepared(prepared);
    const idle = buildIdle({
      journal: fingerprint4({
        recordCount: prepared.journal.post.recordCount,
        headDigest: prepared.journal.post.headDigest,
        rawByteLength: prepared.journal.post.rawByteLength,
        rawSha256: prepared.journal.post.rawSha256,
      }),
      ...last,
    });
    const parsed = mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle));
    assert.equal(parsed.lastSequence, parsed.journal.recordCount - 1);
    // Wrong lastSequence still rejected even if other last* match helper sources.
    idle.lastSequence = parsed.journal.recordCount;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });
});

// ── Encoding / oversize / path-free ────────────────────────────────────

describe('dual-write state encoding, oversize, path-free', () => {
  it('29. oversize state read → io-error (not state-invalid)', async () => {
    await withTempRoot('over-read', async (root) => {
      const mod = await loadStateModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      const huge = `${'x'.repeat(65537)}\n`;
      await writeFile(stateAbs(root), huge, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.loadDualWriteStateUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
            root,
          ),
        );
      });
    });
  });

  it('30. invalid JSON → state-invalid', async () => {
    const mod = await loadStateModule();
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText('{not-json'),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('31. BOM / multi-newline / trailing garbage → state-invalid', async () => {
    const mod = await loadStateModule();
    const idle = JSON.stringify(buildIdle());
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`\uFEFF${idle}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${idle}\n\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${idle} trailing`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(''),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('32. error message === code; no path / event body leakage', async () => {
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    prepared.payloadDigest = HEX64_A;
    try {
      mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared));
      assert.fail('expected throw');
    } catch (error) {
      assertDualWriteError(error, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID, '/tmp');
      assert.ok(!error.message.includes(EVENT_ID));
      assert.ok(!error.message.includes(prepared.eventLineUtf8.trim()));
      assert.ok(!error.message.includes('api.test'));
    }
  });

  it('33. publish uses safeAtomicWriteText; trailing \\n canonical form', async () => {
    await withTempRoot('pub-nl', async (root) => {
      const mod = await loadStateModule();
      const source = await readFile(
        new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
        'utf8',
      );
      assert.ok(source.includes('safeAtomicWriteText'));
      assert.ok(source.includes('mode: 0o600') || source.includes('mode:0o600'));
      await withLease(root, async (resolvedRoot, lease) => {
        await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildIdle());
      });
      const raw = await readFile(stateAbs(root), 'utf8');
      assert.equal(raw.endsWith('\n'), true);
      assert.equal(raw.slice(0, -1).includes('\n'), false);
      assert.deepEqual(
        Object.keys(JSON.parse(raw)),
        [
          'schemaVersion', 'status', 'generationId', 'journal', 'events',
          'lastTransactionId', 'lastPayloadDigest', 'lastSequence',
        ],
      );
    });
  });

  it('34. publish preflight >65536 → state-invalid; no file mutation', async () => {
    // Legal schema is below cap; Buffer.byteLength monkeypatch only locks the
    // guard-before-write branch. finally must restore. Real worst canaries lock
    // the 16050 / ≤65536 math invariants (see R2-D*).
    await withTempRoot('pub-over', async (root) => {
      const mod = await loadStateModule();
      const orig = Buffer.byteLength.bind(Buffer);
      let forced = false;
      Buffer.byteLength = (value, encoding) => {
        const real = orig(value, encoding);
        if (typeof value === 'string' && value.includes('"status":"idle"') && value.includes('schemaVersion')) {
          forced = true;
          return 65537;
        }
        return real;
      };
      try {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildIdle()),
            (e) => assertDualWriteError(
              e,
              ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
              root,
            ),
          );
        });
        assert.equal(forced, true);
        await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      } finally {
        Buffer.byteLength = orig;
      }
    });
  });

  it('35. worst strict event (NUL + lone surrogate) prepared serialize ≤65536', async () => {
    const mod = await loadStateModule();
    const nulEvent = projectStrictCanonicalSanitizedEvent({
      id: EVENT_ID,
      createdAt: '2026-07-19T00:00:00.000Z',
      type: 'api.test',
      message: `nul\u0000canary-${'m'.repeat(180)}`,
    });
    const surrEvent = projectStrictCanonicalSanitizedEvent({
      id: EVENT_ID,
      createdAt: '2026-07-19T00:00:00.000Z',
      type: 'api.test',
      message: `lone\uD800surrogate-${'s'.repeat(170)}`,
    });
    for (const event of [nulEvent, surrEvent]) {
      const prepared = buildPrepared({
        event,
        eventLineUtf8: `${stringifyStrictCanonicalSanitizedEvent(event)}\n`,
        payloadDigest: computeAuditIntegrityEventPayloadDigest(event),
      });
      const text = `${JSON.stringify(mod.parseAuditIntegrityDualWriteStateText(
        JSON.stringify(prepared),
      ))}\n`;
      assert.ok(Buffer.byteLength(text, 'utf8') <= 65536);
    }
  });

  it('36. 65537 synthetic fixture rejected (parse invalid or load io)', async () => {
    const mod = await loadStateModule();
    const raw = `${'y'.repeat(65537)}\n`;
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(raw),
      (e) => {
        assert.equal(e.name, 'AuditIntegrityDualWriteError');
        assert.ok(
          e.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID
            || e.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
        );
        return true;
      },
    );
  });
});

// ── Gate occupancy ─────────────────────────────────────────────────────

describe('dual-write state absent gate occupancy', () => {
  it('37. gate exact ENOENT (missing leaf) → allow signal', async () => {
    await withTempRoot('gate-enoent', async (root) => {
      const mod = await loadStateModule();
      await withLease(root, async (resolvedRoot, lease) => {
        const signal = await mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease);
        assert.equal(signal, undefined);
      });
    });
  });

  it('38. dual-write-state source does not import journal/coordinator/audit-log', async () => {
    const source = await readFile(
      new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
      'utf8',
    );
    assert.equal(source.includes("from './audit-integrity-journal.js'"), false);
    assert.equal(source.includes("from './audit-integrity-dual-write.js'"), false);
    assert.equal(source.includes("from './audit-log.js'"), false);
    assert.equal(/from\s+['"][^'"]*journal['"]/.test(source), false);
  });

  it('39. state parser does not recompute full raw post hash from pre (source contract)', async () => {
    const source = await readFile(
      new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
      'utf8',
    );
    // Must use shared payload digest SoT; must not reimplement link/raw post chain formula domains.
    assert.ok(source.includes('computeAuditIntegrityEventPayloadDigest'));
    assert.equal(source.includes('linke.audit-integrity-journal.v1.event-link'), false);
    assert.equal(source.includes('linke.audit-integrity-journal.v1.event-payload'), false);
    assert.equal(source.includes('createHash'), false);
  });

  it('40. prepared.journal.* fieldwise plan equality helper/fixture contract note', async () => {
    // C2 documents the C4 contract: prepared.journal pre/post must match journal plan fields.
    // Parser binds relationships only; does not recompute linkDigest from event.
    const mod = await loadStateModule();
    const prepared = buildPrepared();
    const parsed = mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared));
    assert.equal(parsed.journal.post.previousLinkDigest, parsed.journal.pre.headDigest);
    assert.equal(parsed.journal.post.linkDigest, parsed.journal.post.headDigest);
    assert.equal(parsed.journal.post.recordCount, parsed.journal.pre.recordCount + 1);
    assert.equal(parsed.journal.post.sequence, parsed.journal.pre.recordCount);
  });

  it('41. no stub/TODO/always-allow/skeleton/write-only in state module', async () => {
    const source = await readFile(
      new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
      'utf8',
    );
    for (const ban of ['TODO', 'FIXME', 'always-allow', 'alwaysAllow', 'skeleton', 'write-only', 'writeOnly', 'not implemented', 'stub gate']) {
      assert.equal(source.includes(ban), false, `banned token: ${ban}`);
    }
  });

  it('42. state module exports real parser+publisher+gate (not write-only)', async () => {
    const mod = await loadStateModule();
    assert.equal(typeof mod.parseAuditIntegrityDualWriteStateText, 'function');
    assert.equal(typeof mod.publishDualWriteStateUnlocked, 'function');
    assert.equal(typeof mod.loadDualWriteStateUnlocked, 'function');
    assert.equal(typeof mod.assertDualWriteStateAbsentUnlocked, 'function');
    const parsed = mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(buildIdle()));
    assert.equal(parsed.status, 'idle');
  });

  it('43. gate orthogonal to lease: missing lease fails closed; occupancy independent', async () => {
    await withTempRoot('gate-lease', async (root) => {
      const mod = await loadStateModule();
      const { assertSafeDataRoot, SafeDataFileError } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      // Outside lease context → lease reject (SafeDataFileError), not dual-write occupied.
      await assert.rejects(
        () => mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, Object.freeze({})),
        (e) => e instanceof SafeDataFileError,
      );
      // With active lease + absent → allow.
      await withLease(root, async (rr, lease) => {
        await mod.assertDualWriteStateAbsentUnlocked(rr, lease);
      });
      // Occupy then gate blocks with DIRECT_MUTATION_BLOCKED under valid lease.
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), 'occupied\n', { mode: 0o600 });
      await withLease(root, async (rr, lease) => {
        await assert.rejects(
          () => mod.assertDualWriteStateAbsentUnlocked(rr, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
            root,
          ),
        );
      });
    });
  });

  it('44. hand-publish valid idle → gate occupied block', async () => {
    await withTempRoot('gate-idle', async (root) => {
      const mod = await loadStateModule();
      await withLease(root, async (resolvedRoot, lease) => {
        await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildIdle());
        await assert.rejects(
          () => mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
            root,
          ),
        );
      });
    });
  });

  it('45. hand-publish invalid JSON state → gate occupied block', async () => {
    await withTempRoot('gate-bad', async (root) => {
      const mod = await loadStateModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{bad', { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
            root,
          ),
        );
      });
    });
  });

  it('46. unsafe state (symlink/dir) → gate occupied; load → io-error', async () => {
    await withTempRoot('gate-unsafe', async (root) => {
      const mod = await loadStateModule();
      // Directory leaf.
      await mkdir(stateAbs(root), { recursive: true });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
            root,
          ),
        );
        await assert.rejects(
          () => mod.loadDualWriteStateUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
            root,
          ),
        );
      });
      await rm(stateAbs(root), { recursive: true, force: true });
      // Symlink leaf.
      const outside = await mkdtempSafe('gate-sym-out');
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, JSON.stringify(buildIdle()), { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, stateAbs(root));
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
            (e) => assertDualWriteError(
              e,
              ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
              root,
            ),
          );
          await assert.rejects(
            () => mod.loadDualWriteStateUnlocked(resolvedRoot, lease),
            (e) => assertDualWriteError(
              e,
              ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
              root,
            ),
          );
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('47. publisher post-load exact: status/cursor match after publish', async () => {
    await withTempRoot('post-load', async (root) => {
      const mod = await loadStateModule();
      const prepared = buildPrepared();
      await withLease(root, async (resolvedRoot, lease) => {
        await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);
        const loaded = await mod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded.status, 'prepared');
        assert.equal(loaded.transactionId, prepared.transactionId);
        assert.equal(loaded.payloadDigest, prepared.payloadDigest);
        assert.equal(loaded.journal.post.sequence, prepared.journal.post.sequence);
        assert.deepEqual(loaded.event, prepared.event);
      });
    });
  });

  it('48. C2 production path does not create state (cold absent remains ENOENT)', async () => {
    await withTempRoot('cold', async (root) => {
      const mod = await loadStateModule();
      // Module APIs alone with load missing → null; no auto-create.
      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await mod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded, null);
        await mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease);
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('49. empty state file occupied for gate; present=false requires empty sha', async () => {
    await withTempRoot('empty-file', async (root) => {
      const mod = await loadStateModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '', { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.assertDualWriteStateAbsentUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
            root,
          ),
        );
      });
      const badEmpty = buildIdle({
        events: eventsFp({ present: false, byteLength: 0, sha256: HEX64_A, strictRecordCount: 0 }),
      });
      assert.throws(
        () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(badEmpty)),
        (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
      );
    });
  });

  it('50. load missing exact ENOENT → null; unsafe integer rejected', async () => {
    await withTempRoot('load-null', async (root) => {
      const mod = await loadStateModule();
      await withLease(root, async (resolvedRoot, lease) => {
        assert.equal(await mod.loadDualWriteStateUnlocked(resolvedRoot, lease), null);
      });
      const idle = buildIdle({
        journal: fingerprint4({ recordCount: Number.MAX_SAFE_INTEGER + 1 }),
      });
      // JSON may coerce; force unsafe via object validate on publish path.
      await withLease(root, async (resolvedRoot, lease) => {
        const bad = buildIdle();
        bad.journal.recordCount = 1.5;
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, bad),
          (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
        );
      });
    });
  });

  it('51. payloadDigest SoT shared via audit-event-schema (no formula copy in state)', async () => {
    const schemaSource = await readFile(
      new URL('../src/audit-event-schema.js', import.meta.url),
      'utf8',
    );
    const stateSource = await readFile(
      new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
      'utf8',
    );
    const journalSource = await readFile(
      new URL('../src/audit-integrity-journal.js', import.meta.url),
      'utf8',
    );
    assert.ok(schemaSource.includes('computeAuditIntegrityEventPayloadDigest'));
    assert.ok(schemaSource.includes('linke.audit-integrity-journal.v1.event-payload'));
    assert.ok(stateSource.includes("from './audit-event-schema.js'"));
    assert.ok(stateSource.includes('computeAuditIntegrityEventPayloadDigest'));
    // Journal remains compatibility export (thin wrapper/re-export path).
    assert.ok(journalSource.includes('export function computeAuditIntegrityEventPayloadDigest'));
    assert.ok(
      journalSource.includes('computeAuditIntegrityEventPayloadDigest')
        && (
          journalSource.includes("from './audit-event-schema.js'")
          || journalSource.includes('from "./audit-event-schema.js"')
        ),
    );
    // State must not copy domain string or createHash.
    assert.equal(stateSource.includes('linke.audit-integrity-journal.v1.event-payload'), false);
    assert.equal(stateSource.includes('createHash'), false);
  });

  it('52. journal nested key order wrong → state-invalid; retention extra key invalid', async () => {
    const mod = await loadStateModule();
    const idle = buildIdle();
    idle.journal = {
      headDigest: HEX64_A,
      recordCount: 1,
      rawByteLength: 0,
      rawSha256: HEX64_B,
    };
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(idle)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    const prepared = buildPrepared({ retention: { maxEvents: 1, extra: 1 } });
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });
});

// ── C2 round-2: hostile Proxy / nested / raw canonical / post-exact / worst 16050 ──

const EXTENDED_DATE = '+275760-09-13T00:00:00.000Z';
const MAX_EVENT_STR_FIELDS = Object.freeze([
  'type',
  'method',
  'path',
  'outcome',
  'requestId',
  'deviceId',
  'snapshotId',
  'operation',
  'message',
  'targetName',
  'attemptId',
  'errorCode',
]);

/** Reuse cross-store worst-event layout: 16050 exact strict canonical line. */
function buildMaxEvent(fill) {
  const o = {
    id: fill,
    createdAt: EXTENDED_DATE,
    statusCode: -Number.MAX_VALUE,
    fileCount: Number.MAX_VALUE,
    totalBytes: Number.MAX_VALUE,
    verifiedFileCount: Number.MAX_VALUE,
    retryCount: Number.MAX_VALUE,
    wouldWrite: true,
    executionRequired: true,
  };
  for (const k of MAX_EVENT_STR_FIELDS) o[k] = fill;
  return o;
}

function buildPreparedWithEvent(event, overrides = {}) {
  const projected = projectStrictCanonicalSanitizedEvent(event);
  const eventLineUtf8 = `${stringifyStrictCanonicalSanitizedEvent(projected)}\n`;
  const payloadDigest = computeAuditIntegrityEventPayloadDigest(projected);
  return buildPrepared({
    event: projected,
    eventLineUtf8,
    payloadDigest,
    ...overrides,
  });
}

describe('C2 R2: hostile Proxy / nested object reject (no stringify whitewash)', () => {
  it('R2-A1. top-level ordinary Proxy → publish STATE_INVALID, no file; traps never fire', async () => {
    await withTempRoot('r2-proxy-top', async (root) => {
      const mod = await loadStateModule();
      const target = buildIdle();
      const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
      const proxy = new Proxy(target, {
        get(...args) {
          traps.get += 1;
          return Reflect.get(...args);
        },
        ownKeys(...args) {
          traps.ownKeys += 1;
          return Reflect.ownKeys(...args);
        },
        getOwnPropertyDescriptor(...args) {
          traps.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(...args);
        },
        getPrototypeOf(...args) {
          traps.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(...args);
        },
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, proxy),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
            root,
          ),
        );
      });
      assert.deepEqual(traps, {
        get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0,
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('R2-A2. nested journal Proxy → publish STATE_INVALID, no file', async () => {
    await withTempRoot('r2-proxy-journal', async (root) => {
      const mod = await loadStateModule();
      const idle = buildIdle();
      idle.journal = new Proxy(fingerprint4(), {});
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
            root,
          ),
        );
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('R2-A3. nested journal class instance with toJSON() → STATE_INVALID (no whitewash)', async () => {
    await withTempRoot('r2-class-tojson', async (root) => {
      const mod = await loadStateModule();
      const legalFp = fingerprint4();
      class HostileJournal {
        toJSON() {
          return legalFp;
        }
      }
      const idle = buildIdle();
      idle.journal = new HostileJournal();
      // Prove stringify would whitewash if publisher still used it.
      assert.deepEqual(JSON.parse(JSON.stringify(idle)).journal, legalFp);
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
            root,
          ),
        );
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('R2-A4. nested journal non-enumerable/accessor/toJSON → STATE_INVALID; SECRET not leaked', async () => {
    const mod = await loadStateModule();
    const base = fingerprint4();

    // non-enumerable extra secret
    const nonEnum = { ...base };
    Object.defineProperty(nonEnum, 'secret', {
      value: 'SECRET_NONENUM /tmp/path',
      enumerable: false,
    });
    await withTempRoot('r2-nonenum', async (root) => {
      const idle1 = buildIdle({ journal: nonEnum });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle1),
          (e) => {
            assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID, root);
            assert.ok(!e.message.includes('SECRET'));
            assert.ok(!e.message.includes('/tmp'));
            return true;
          },
        );
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });

    // accessor own properties (JSON.stringify would invoke getters and whitewash)
    const withAccessor = {};
    for (const [k, v] of Object.entries(base)) {
      Object.defineProperty(withAccessor, k, {
        enumerable: true,
        configurable: true,
        get() {
          return v;
        },
      });
    }
    await withTempRoot('r2-accessor', async (root) => {
      const idle2 = buildIdle({ journal: withAccessor });
      // Prove stringify would whitewash accessors into plain data.
      assert.deepEqual(JSON.parse(JSON.stringify(idle2)).journal, base);
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle2),
          (e) => {
            assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID, root);
            assert.ok(!e.message.includes('SECRET'));
            return true;
          },
        );
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });

    // enumerable toJSON that would rewrite fingerprint if stringified
    const withToJson = {
      ...base,
      toJSON() {
        return { ...base, headDigest: HEX64_F };
      },
    };
    await withTempRoot('r2-tojson', async (root) => {
      const idle3 = buildIdle({ journal: withToJson });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle3),
          (e) => {
            assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID, root);
            assert.ok(!e.message.includes('SECRET'));
            assert.ok(!String(e.stack || '').includes('SECRET_NONENUM'));
            return true;
          },
        );
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('R2-A5. helper rejects Proxy getPrototypeOf throw → STATE_INVALID, no SECRET leak', async () => {
    const mod = await loadStateModule();
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('SECRET /path/to/state');
      },
      get() {
        throw new Error('SECRET /path/to/state');
      },
    });
    assert.throws(
      () => mod.buildSuccessfulIdleLastFieldsFromPrepared(proxy),
      (e) => {
        assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
        assert.ok(!e.message.includes('SECRET'));
        assert.ok(!e.message.includes('/path'));
        assert.equal(e.message, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
        return true;
      },
    );
  });
});

describe('C2 R2: raw full-file canonical identity', () => {
  it('R2-B1. legal idle with internal space/tab → STATE_INVALID', async () => {
    const mod = await loadStateModule();
    const canonical = JSON.stringify(buildIdle());
    // Insert space after first colon
    const withSpace = canonical.replace(':', ': ');
    assert.notEqual(withSpace, canonical);
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${withSpace}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    const withTab = canonical.replace(',', ',\t');
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(withTab),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('R2-B2. duplicate fixed key (status last-wins still semantic-legal) → STATE_INVALID', async () => {
    const mod = await loadStateModule();
    const base = JSON.stringify(buildIdle());
    // Inject duplicate "status":"idle" — JSON.parse last-wins keeps status idle.
    const dup = base.replace('"status":"idle"', '"status":"prepared","status":"idle"');
    assert.equal(JSON.parse(dup).status, 'idle');
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${dup}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('R2-B3. alternative escape (\\/ or \\u0069) → STATE_INVALID', async () => {
    const mod = await loadStateModule();
    const canonical = JSON.stringify(buildIdle());
    // Slash escape in a string value path is not present; use generation hex letter via unicode escape.
    // Replace first "i" of "idle" status with \u0069 form in raw text.
    const altUnicode = canonical.replace('"idle"', '"\u0069dle"'.replace('i', '\\u0069'));
    // Explicit: status value via unicode escapes for 'i','d','l','e'
    const altStatus = canonical.replace('"status":"idle"', '"status":"\\u0069dle"');
    assert.equal(JSON.parse(altStatus).status, 'idle');
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${altStatus}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    // Alternative solidus escape on a string that can hold /
    // generationId has no slash; inject into a digest-like field via raw replace of empty path.
    // Use events.sha256 empty-file form is hex only. Force \/ inside a JSON string key-adjacent:
    // craft prepared eventLineUtf8 is complex; use raw text with escaped solidus in type via prepared.
    const prepared = buildPrepared();
    const prepCanonical = JSON.stringify(prepared);
    // type is "api.test" — no slash. Escape a letter in "status":"prepared"
    const altPrep = prepCanonical.replace('"prepared"', '"\\u0070repared"');
    assert.equal(JSON.parse(altPrep).status, 'prepared');
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(altPrep),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
    void altUnicode;
    // Solidus escape: insert \/ into a JSON string that still parses to same value.
    // "api.test" → keep same chars but with \/ if we had path; use method-like via raw
    // Replace nothing — craft idle raw with generationId and force \/ in a synthetic string field.
    // idle has no path field. Use events.sha256 is hex. Alternative: escape / in empty? N/A.
    // Spec allows / → \/ : inject into raw by rewriting a hex64 that contains no slash —
    // use prepared eventLineUtf8 which contains no slash either.
    // Build raw with an extra key is invalid for other reasons. Use:
    // JSON allows "\/" ≡ "/" — put slash into message field of prepared event.
    const eventWithSlash = projectStrictCanonicalSanitizedEvent({
      ...STRICT_EVENT,
      message: 'a/b',
    });
    const prepSlash = buildPreparedWithEvent(eventWithSlash);
    const slashCanonical = JSON.stringify(prepSlash);
    const altSlash = slashCanonical.replace('a/b', 'a\\/b');
    assert.equal(JSON.parse(altSlash).event.message, 'a/b');
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${altSlash}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );
  });

  it('R2-B4. publish output exact one-line canonical + exactly one trailing newline', async () => {
    await withTempRoot('r2-pub-raw', async (root) => {
      const mod = await loadStateModule();
      const idle = buildIdle();
      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, idle);
        const expected = `${JSON.stringify(loaded)}\n`;
        const raw = await readFile(stateAbs(root), 'utf8');
        assert.equal(raw, expected);
        assert.equal(raw.endsWith('\n'), true);
        assert.equal(raw.endsWith('\n\n'), false);
        assert.equal(raw.slice(0, -1).includes('\n'), false);
        assert.equal(raw.includes(' '), false);
        assert.equal(raw.includes('\t'), false);
      });
    });
  });
});

describe('C2 R2: publish post-write exact raw + swap fault injection', () => {
  it('R2-C1. source: post-write safeReadText exact raw before parse; IO remap', async () => {
    const source = await readFile(
      new URL('../src/audit-integrity-dual-write-state.js', import.meta.url),
      'utf8',
    );
    const pubStart = source.indexOf('export async function publishDualWriteStateUnlocked');
    assert.ok(pubStart >= 0);
    const nextExport = source.indexOf('\nexport ', pubStart + 10);
    const pubBody = source.slice(pubStart, nextExport === -1 ? undefined : nextExport);
    const atomicAt = pubBody.indexOf('safeAtomicWriteText');
    const postReadAt = pubBody.indexOf('safeReadText', atomicAt + 1);
    assert.ok(atomicAt >= 0 && postReadAt > atomicAt, 'post-write must reopen via safeReadText');
    // Must compare exact raw text (postRaw === expectedText), not only object deep-equal.
    assert.ok(
      pubBody.includes('postRaw') || pubBody.includes('postText') || /!==\s*text/.test(pubBody)
        || pubBody.includes('expectedText'),
      'post-write exact raw compare required',
    );
    // No production DI backdoor symbols.
    assert.equal(pubBody.includes('__test'), false);
    assert.equal(pubBody.includes('faultInject'), false);
    assert.equal(pubBody.includes('afterWriteHook'), false);
  });

  it('R2-C2. runtime post-rename swap → DUAL_WRITE_IO_ERROR; invalid raw; stress ≥10', async () => {
    const mod = await loadStateModule();
    const stress = 10;
    for (let i = 0; i < stress; i += 1) {
      await withTempRoot(`r2-swap-${i}`, async (root) => {
        const abs = stateAbs(root);
        const auditDir = join(root, 'audit');
        const injectedBytes = `POST_RENAME_SWAP_INVALID_RAW_${i}\n`;

        await withLease(root, async (resolvedRoot, lease) => {
          // Baseline publish first.
          const baseline = buildIdle({
            generationId: GENERATION_ID,
            journal: fingerprint4({ recordCount: 1, headDigest: HEX64_A }),
          });
          await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, baseline);

          // Different expected next state (still legal idle with different cursor).
          const next = buildIdle({
            generationId: GENERATION_ID,
            journal: fingerprint4({
              recordCount: 2,
              headDigest: HEX64_C,
              rawByteLength: 100,
              rawSha256: HEX64_D,
            }),
            lastTransactionId: TX_ID,
            lastPayloadDigest: HEX64_E,
            lastSequence: 1,
          });
          // Canonical expected raw after successful publish (no whitewash path).
          const expectedCanonical = `${JSON.stringify(
            mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(next)),
          )}\n`;

          let injected = false;
          const tryInjectAfterRenameCommit = () => {
            if (injected) return;
            try {
              const cur = readFileSync(abs, 'utf8');
              // Only after rename commits the *new* expected canonical bytes.
              if (cur !== expectedCanonical) return;
              if (cur === injectedBytes) {
                injected = true;
                return;
              }
              writeFileSync(abs, injectedBytes);
              injected = true;
            } catch {
              // Mid-rename ENOENT / transient.
            }
          };

          const watcher = watch(auditDir, (eventType, filename) => {
            void eventType;
            const name = filename == null ? '' : String(filename);
            if (!name || name.startsWith('.tmp-')) return;
            if (name !== 'integrity-dual-write-state.json') return;
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
              () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, next),
              (e) => {
                assertDualWriteError(
                  e,
                  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
                  root,
                );
                assert.notEqual(
                  e.code,
                  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
                );
                return true;
              },
            );
            assert.equal(injected, true, `stress#${i}: runtime post-rename inject must fire`);
            assert.equal(await readFile(abs, 'utf8'), injectedBytes);
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
    }
  });

  it('R2-C3. load API still STATE_INVALID on invalid raw (not remapped to IO)', async () => {
    await withTempRoot('r2-load-invalid', async (root) => {
      const mod = await loadStateModule();
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{not-valid-state\n', { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.loadDualWriteStateUnlocked(resolvedRoot, lease),
          (e) => assertDualWriteError(
            e,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
            root,
          ),
        );
      });
    });
  });
});

describe('C2 R2: true worst 16050 event / state bound', () => {
  it('R2-D1. NUL max event strict line exact 16050; prepared ≤65536; publish/load', async () => {
    await withTempRoot('r2-worst-nul', async (root) => {
      const mod = await loadStateModule();
      const nul = '\u0000'.repeat(200);
      const line = stringifyStrictCanonicalSanitizedEvent(buildMaxEvent(nul));
      assert.equal(Buffer.byteLength(line, 'utf8'), 16050);

      const highPre = Number.MAX_SAFE_INTEGER - 1;
      const prepared = buildPreparedWithEvent(buildMaxEvent(nul), {
        retention: null,
        journal: {
          pre: fingerprint4({
            recordCount: highPre,
            headDigest: HEX64_A,
            rawByteLength: Number.MAX_SAFE_INTEGER,
            rawSha256: HEX64_B,
          }),
          post: {
            recordCount: highPre + 1,
            headDigest: HEX64_C,
            rawByteLength: Number.MAX_SAFE_INTEGER,
            rawSha256: HEX64_D,
            sequence: highPre,
            linkDigest: HEX64_C,
            previousLinkDigest: HEX64_A,
          },
        },
        events: {
          pre: eventsFp({
            present: true,
            byteLength: Number.MAX_SAFE_INTEGER,
            sha256: HEX64_E,
            strictRecordCount: highPre,
          }),
          post: eventsFp({
            present: true,
            byteLength: Number.MAX_SAFE_INTEGER,
            sha256: HEX64_F,
            strictRecordCount: highPre + 1,
          }),
        },
      });
      // State has fingerprints/count only — not an events array of full records.
      assert.equal(Array.isArray(prepared.events), false);
      assert.equal('pre' in prepared.events && 'post' in prepared.events, true);

      const text = `${JSON.stringify(
        mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      )}\n`;
      assert.ok(Buffer.byteLength(text, 'utf8') <= 65536);

      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);
        assert.equal(loaded.status, 'prepared');
        const raw = await readFile(stateAbs(root), 'utf8');
        assert.equal(raw, text);
        const reloaded = await mod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.deepEqual(reloaded, loaded);
      });
    });
  });

  it('R2-D2. lone-surrogate max event independent exact 16050; retention enabled', async () => {
    await withTempRoot('r2-worst-surr', async (root) => {
      const mod = await loadStateModule();
      const lone = '\uD800'.repeat(200);
      const line = stringifyStrictCanonicalSanitizedEvent(buildMaxEvent(lone));
      assert.equal(Buffer.byteLength(line, 'utf8'), 16050);

      const prepared = buildPreparedWithEvent(buildMaxEvent(lone), {
        retention: { maxEvents: 3 },
        events: {
          pre: eventsFp({
            present: true, byteLength: 100, sha256: HEX64_E, strictRecordCount: 10,
          }),
          post: eventsFp({
            present: true, byteLength: 200, sha256: HEX64_F, strictRecordCount: 3,
          }),
        },
      });
      const text = `${JSON.stringify(
        mod.parseAuditIntegrityDualWriteStateText(JSON.stringify(prepared)),
      )}\n`;
      assert.ok(Buffer.byteLength(text, 'utf8') <= 65536);
      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await mod.publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);
        assert.equal(loaded.events.post.strictRecordCount, 3);
        assert.deepEqual(loaded.retention, { maxEvents: 3 });
      });
    });
  });

  it('R2-D3. 65537 synthetic raw still rejected; Buffer.byteLength patch is guard-only', async () => {
    const mod = await loadStateModule();
    // Real oversize synthetic fixture (not "legal event +1" — schema already caps event).
    assert.throws(
      () => mod.parseAuditIntegrityDualWriteStateText(`${'z'.repeat(65537)}\n`),
      (e) => assertDualWriteError(e, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID),
    );

    // Monkeypatch only locks publish guard-before-write branch; finally must restore.
    await withTempRoot('r2-guard-patch', async (root) => {
      const orig = Buffer.byteLength.bind(Buffer);
      let forced = false;
      Buffer.byteLength = (value, encoding) => {
        const real = orig(value, encoding);
        if (
          typeof value === 'string'
          && value.includes('"status":"idle"')
          && value.includes('schemaVersion')
        ) {
          forced = true;
          return 65537;
        }
        return real;
      };
      try {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => mod.publishDualWriteStateUnlocked(resolvedRoot, lease, buildIdle()),
            (e) => assertDualWriteError(
              e,
              ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
              root,
            ),
          );
        });
        assert.equal(forced, true);
        await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      } finally {
        Buffer.byteLength = orig;
      }
      assert.equal(Buffer.byteLength('x', 'utf8'), 1);
    });
  });
});
