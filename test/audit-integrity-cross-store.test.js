/**
 * V1.36 C2+C3 core: audit event/journal cross-store structural consistency verifier.
 * C2: bounds canaries, truth table 1a/1b/2–7, events error priority, journal typed
 * rethrow, receipt allowlist, options traps.
 * C3: documents-* honest limitations (success/partial only) + hostile broken
 * canaries + repeated-digest suffix truth canaries.
 * Forbidden capability compound is never written as a contiguous literal here
 * (C3 scans use runtime-concat needle).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import { stringifyStrictCanonicalSanitizedEvent } from '../src/audit-event-schema.js';

const GENERATION_ID = '0123456789abcdef0123456789abcdef';

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/a',
  outcome: 'success',
});

const EVENT_B = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/b',
  outcome: 'success',
});

const EVENT_C = Object.freeze({
  id: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/c',
  outcome: 'success',
});

const EVENT_0 = Object.freeze({
  id: '00000000-0000-4000-8000-000000000000',
  createdAt: '2026-07-17T00:00:00.000Z',
  type: 'api.test',
  method: 'GET',
  path: '/api/legacy',
  outcome: 'success',
});

const RECEIPT_KEYS = Object.freeze([
  'state',
  'relationship',
  'generationId',
  'headDigest',
  'journalEventCount',
  'retainedEventCount',
  'matchedEventCount',
  'uncoveredEventCount',
]);

const EXTENDED_DATE = '+275760-09-13T00:00:00.000Z';
const STR_FIELDS = Object.freeze([
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

async function mkdtempSafe(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), `linke-xstore-${prefix}-`));
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtempSafe(prefix);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

async function writeEventsRaw(root, raw) {
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(eventsAbs(root), raw, { mode: 0o600 });
}

async function writeEventsLines(root, events) {
  const body = events.map((e) => stringifyStrictCanonicalSanitizedEvent(e)).join('\n');
  const raw = events.length === 0 ? '' : `${body}\n`;
  await writeEventsRaw(root, raw);
}

async function loadCrossStore() {
  return import('../src/audit-integrity-cross-store.js');
}

async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}

function buildMaxEvent(fill) {
  const o = {
    id: fill,
    createdAt: EXTENDED_DATE,
    // statusCode allows negatives → -MAX adds one JSON char (minus) to hit frozen 16050.
    statusCode: -Number.MAX_VALUE,
    // four non-negative integer fields → +MAX only
    fileCount: Number.MAX_VALUE,
    totalBytes: Number.MAX_VALUE,
    verifiedFileCount: Number.MAX_VALUE,
    retryCount: Number.MAX_VALUE,
    wouldWrite: true,
    executionRequired: true,
  };
  for (const k of STR_FIELDS) o[k] = fill;
  return o;
}

function assertCrossStoreError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityCrossStoreError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  assert.ok(!('cause' in error) || error.cause === undefined);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('EACCES'));
  assert.ok(!error.message.includes('SECRET'));
  assert.ok(!/\/var\/|\/tmp\/|\/Users\//.test(error.message));
}

function assertReceiptShape(receipt) {
  assert.equal(typeof receipt, 'object');
  assert.ok(receipt !== null);
  assert.deepEqual(Object.keys(receipt), [...RECEIPT_KEYS]);
  assert.ok(!('ok' in receipt));
  assert.ok(!('raw' in receipt));
  assert.ok(!('digests' in receipt));
  assert.ok(!('path' in receipt));
  assert.ok(!('body' in receipt));
  assert.ok(!('payloadDigests' in receipt));
  for (const k of RECEIPT_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(receipt, k));
  }
  assert.ok(
    receipt.state === 'verified' || receipt.state === 'partial',
    `unexpected state ${receipt.state}`,
  );
  assert.equal(typeof receipt.journalEventCount, 'number');
  assert.equal(typeof receipt.retainedEventCount, 'number');
  assert.equal(typeof receipt.matchedEventCount, 'number');
  assert.equal(typeof receipt.uncoveredEventCount, 'number');
  assert.ok(receipt.journalEventCount >= 0);
  assert.ok(receipt.retainedEventCount >= 0);
  assert.ok(receipt.matchedEventCount >= 0);
  assert.ok(receipt.uncoveredEventCount >= 0);
  assert.ok(Number.isInteger(receipt.journalEventCount));
  assert.ok(Number.isInteger(receipt.retainedEventCount));
  assert.ok(Number.isInteger(receipt.matchedEventCount));
  assert.ok(Number.isInteger(receipt.uncoveredEventCount));
}

function assertReceipt(receipt, expected) {
  assertReceiptShape(receipt);
  assert.equal(receipt.state, expected.state);
  assert.equal(receipt.relationship, expected.relationship);
  assert.equal(receipt.generationId, expected.generationId);
  assert.equal(receipt.headDigest, expected.headDigest);
  assert.equal(receipt.journalEventCount, expected.journalEventCount);
  assert.equal(receipt.retainedEventCount, expected.retainedEventCount);
  assert.equal(receipt.matchedEventCount, expected.matchedEventCount);
  assert.equal(receipt.uncoveredEventCount, expected.uncoveredEventCount);
  if (Object.isFrozen(receipt)) {
    assert.equal(Object.isFrozen(receipt), true);
  }
}

function makeHostileOptions() {
  const counts = {
    get: 0,
    has: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    set: 0,
  };
  const target = {};
  const options = new Proxy(target, {
    get(_t, prop, receiver) {
      counts.get += 1;
      return Reflect.get(_t, prop, receiver);
    },
    has(_t, prop) {
      counts.has += 1;
      return Reflect.has(_t, prop);
    },
    ownKeys(_t) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(_t);
    },
    getOwnPropertyDescriptor(_t, prop) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(_t, prop);
    },
    set(_t, prop, value, receiver) {
      counts.set += 1;
      return Reflect.set(_t, prop, value, receiver);
    },
  });
  return { options, counts };
}

// ---------------------------------------------------------------------------
// Bounds proofs (plan items 1–7)
// ---------------------------------------------------------------------------

describe('cross-store bounds constants and canaries', () => {
  it('1: locks MAX_EVENT_LINE_BYTES=16050, MAX_EVENT_LINES=8192, MAX_PRE_READ=16MiB', async () => {
    const mod = await loadCrossStore();
    assert.equal(mod.AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES, 16050);
    assert.equal(mod.AUDIT_CROSS_STORE_MAX_EVENT_LINES, 8192);
    assert.equal(mod.AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES, 16_777_216);
    assert.equal(mod.AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH, 'audit/events.jsonl');
  });

  it('2: NUL canary + canonical extended date + -MAX status + four +MAX → 16050', () => {
    assert.equal(new Date(EXTENDED_DATE).toISOString(), EXTENDED_DATE);
    const nul = '\u0000'.repeat(200);
    const line = stringifyStrictCanonicalSanitizedEvent(buildMaxEvent(nul));
    assert.equal(Buffer.byteLength(line, 'utf8'), 16050);
  });

  it('3: lone-surrogate canary independent → 16050', () => {
    assert.equal(new Date(EXTENDED_DATE).toISOString(), EXTENDED_DATE);
    const lone = '\uD800'.repeat(200);
    const line = stringifyStrictCanonicalSanitizedEvent(buildMaxEvent(lone));
    assert.equal(Buffer.byteLength(line, 'utf8'), 16050);
  });

  it('4: ASCII canary is NOT max (byteLength < 16050)', () => {
    const ascii = 'a'.repeat(200);
    const line = stringifyStrictCanonicalSanitizedEvent(buildMaxEvent(ascii));
    assert.ok(Buffer.byteLength(line, 'utf8') < 16050);
  });

  it('5: Number.MAX_VALUE integer + JSON forms; statusCode must be negative MAX', () => {
    assert.equal(Number.isInteger(Number.MAX_VALUE), true);
    assert.equal(JSON.stringify(Number.MAX_VALUE), '1.7976931348623157e+308');
    assert.equal(JSON.stringify(-Number.MAX_VALUE), '-1.7976931348623157e+308');
    // Positive statusCode MAX cannot reach 16050 with the frozen layout.
    const posStatus = buildMaxEvent('\u0000'.repeat(200));
    posStatus.statusCode = Number.MAX_VALUE;
    const posBytes = Buffer.byteLength(
      stringifyStrictCanonicalSanitizedEvent(posStatus),
      'utf8',
    );
    assert.ok(posBytes < 16050);
    assert.equal(
      Buffer.byteLength(
        stringifyStrictCanonicalSanitizedEvent(buildMaxEvent('\u0000'.repeat(200))),
        'utf8',
      ),
      16050,
    );
  });

  it('6: three caps are independent — MUST NOT floor(PRE_READ/(LINE+1)) derive MAX_LINES', async () => {
    const mod = await loadCrossStore();
    const pre = mod.AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES;
    const line = mod.AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES;
    const lines = mod.AUDIT_CROSS_STORE_MAX_EVENT_LINES;
    const floorDerived = Math.floor(pre / (line + 1));
    assert.notEqual(lines, floorDerived);
    assert.equal(lines, 8192);
    // emoji canary also non-max
    const emoji = '😀'.repeat(100);
    const eLine = stringifyStrictCanonicalSanitizedEvent(buildMaxEvent(emoji));
    assert.ok(Buffer.byteLength(eLine, 'utf8') < 16050);
  });

  it('7: layered honesty — full max-line loads exceed 16MiB; 4096 shortest lines fit pre-read budget', async () => {
    const mod = await loadCrossStore();
    const pre = mod.AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES;
    const line = mod.AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES;
    // Pure budget arithmetic only — does NOT invoke the verifier on 4096 lines.
    assert.ok(
      8192 * (line + 1) > pre,
      '8192 full max-lines exceed the 16MiB pre-read byte budget',
    );
    assert.ok(
      4096 * (line + 1) > pre,
      '4096 full max-lines also exceed the 16MiB pre-read byte budget',
    );
    // 4096 shortest canonical event lines (budget proxy: 64 payload bytes + newline)
    // fit under pre-read; this asserts only the byte-budget relation, not end-to-end verify.
    const shortLineBudget = 64;
    assert.ok(
      4096 * (shortLineBudget + 1) < pre,
      '4096 shortest canonical event lines fit the pre-read byte budget',
    );
  });
});

// ---------------------------------------------------------------------------
// Truth table 1a/1b/2–7 (plan items 8–18)
// ---------------------------------------------------------------------------

describe('cross-store relationship truth table', () => {
  it('8 #1a: no journal + no events → verified empty; meta null; counts 0', async () => {
    await withTempRoot('1a-empty', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'empty',
        generationId: null,
        headDigest: null,
        journalEventCount: 0,
        retainedEventCount: 0,
        matchedEventCount: 0,
        uncoveredEventCount: 0,
      });
    });
  });

  it('9 #1b: journal only-open + events missing/empty → verified empty; open meta kept', async () => {
    await withTempRoot('1b-open-only', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'empty',
        generationId: GENERATION_ID,
        headDigest: init.headDigest,
        journalEventCount: 0,
        retainedEventCount: 0,
        matchedEventCount: 0,
        uncoveredEventCount: 0,
      });
      assert.notEqual(receipt.generationId, null);
      assert.notEqual(receipt.headDigest, null);
    });
  });

  it('10 #2 equal: journal 2 links + events same 2 strict → verified equal; matched=2', async () => {
    await withTempRoot('2-equal', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'equal',
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        journalEventCount: 2,
        retainedEventCount: 2,
        matchedEventCount: 2,
        uncoveredEventCount: 0,
      });
      assert.equal(a1.payloadDigest.length, 64);
    });
  });

  it('11 #3 events-suffix-of-journal: J=[A,B,C] E=[B,C] → verified; matched=2', async () => {
    await withTempRoot('3-events-suffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      const a3 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_C },
      });
      await writeEventsLines(root, [{ ...EVENT_B }, { ...EVENT_C }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'events-suffix-of-journal',
        generationId: GENERATION_ID,
        headDigest: a3.headDigest,
        journalEventCount: 3,
        retainedEventCount: 2,
        matchedEventCount: 2,
        uncoveredEventCount: 0,
      });
    });
  });

  it('12 #4 journal-suffix-of-events: E=[0,A,B] J=[A,B] → partial; uncovered=1', async () => {
    await withTempRoot('4-journal-suffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      await writeEventsLines(root, [{ ...EVENT_0 }, { ...EVENT_A }, { ...EVENT_B }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'partial',
        relationship: 'journal-suffix-of-events',
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        journalEventCount: 2,
        retainedEventCount: 3,
        matchedEventCount: 2,
        uncoveredEventCount: 1,
      });
    });
  });

  it('13 #5 uncovered-events: no journal (or only open) + events 2 → partial; matched=0', async () => {
    await withTempRoot('5-uncovered-missing', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'partial',
        relationship: 'uncovered-events',
        generationId: null,
        headDigest: null,
        journalEventCount: 0,
        retainedEventCount: 2,
        matchedEventCount: 0,
        uncoveredEventCount: 2,
      });
    });

    await withTempRoot('5-uncovered-open-only', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const init = await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'partial',
        relationship: 'uncovered-events',
        generationId: GENERATION_ID,
        headDigest: init.headDigest,
        journalEventCount: 0,
        retainedEventCount: 2,
        matchedEventCount: 0,
        uncoveredEventCount: 2,
      });
    });
  });

  it('14 #6 J non-empty E empty/missing → throw cross-store-broken (no empty-suffix loophole)', async () => {
    await withTempRoot('6-j-nonempty-e-missing', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });

    await withTempRoot('6-j-nonempty-e-empty', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await writeEventsRaw(root, '');
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('15 #7 reorder: E permutation → broken', async () => {
    await withTempRoot('7-reorder', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await writeEventsLines(root, [{ ...EVENT_B }, { ...EVENT_A }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('16 #7 mutate overlap: change last E field → broken', async () => {
    await withTempRoot('7-mutate-overlap', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await writeEventsLines(root, [
        { ...EVENT_A },
        { ...EVENT_B, path: '/api/b-mutated' },
      ]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('17 #7 prefix-not-suffix: E is proper prefix of J → broken', async () => {
    await withTempRoot('7-prefix-not-suffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_C } });
      // E = first two of J (prefix, not suffix)
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('18 #7 insert middle: insert into E middle → broken', async () => {
    await withTempRoot('7-insert-middle', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_C } });
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }, { ...EVENT_C }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Events parse / error priority + journal error propagation (items 19–27)
// ---------------------------------------------------------------------------

describe('cross-store events parse error priority and journal rethrow', () => {
  it('19: non-empty missing final newline → event-invalid (after bounds)', async () => {
    await withTempRoot('ev-no-final-nl', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const line = stringifyStrictCanonicalSanitizedEvent({ ...EVENT_A });
      await writeEventsRaw(root, line); // no trailing \n
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          return true;
        },
      );
    });
  });

  it('20: interior blank line → event-invalid', async () => {
    await withTempRoot('ev-blank-line', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const a = stringifyStrictCanonicalSanitizedEvent({ ...EVENT_A });
      const b = stringifyStrictCanonicalSanitizedEvent({ ...EVENT_B });
      await writeEventsRaw(root, `${a}\n\n${b}\n`);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          return true;
        },
      );
    });
  });

  it('20b: sole blank line raw="\\n" + journal missing → event-invalid (not empty E=[])', async () => {
    await withTempRoot('ev-sole-nl-missing-j', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      // Journal absent (NOT_INITIALIZED → J=[]). Sole newline must not collapse to empty.
      await writeEventsRaw(root, '\n');
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
          return true;
        },
      );
    });
  });

  it('20c: sole blank line raw="\\n" + journal open-only → event-invalid (not empty E=[])', async () => {
    await withTempRoot('ev-sole-nl-open-only', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      // Open-only journal keeps meta; sole newline still event-invalid (not verified empty).
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await writeEventsRaw(root, '\n');
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
          return true;
        },
      );
    });
  });

  it('21: bad JSON → event-invalid', async () => {
    await withTempRoot('ev-bad-json', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await writeEventsRaw(root, '{not-json\n');
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          return true;
        },
      );
    });
  });

  it('22: extra key / non-canonical re-stringify mismatch → event-invalid', async () => {
    await withTempRoot('ev-extra-key', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const base = { ...EVENT_A, extra: 'nope' };
      // Intentionally non-strict dump (extra key) — must not pass via sanitize.
      await writeEventsRaw(root, `${JSON.stringify(base)}\n`);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          return true;
        },
      );
    });

    await withTempRoot('ev-key-order-mismatch', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      // Wrong key order relative to strict canonical field order.
      const wrongOrder = JSON.stringify({
        createdAt: EVENT_A.createdAt,
        id: EVENT_A.id,
        type: EVENT_A.type,
        method: EVENT_A.method,
        path: EVENT_A.path,
        outcome: EVENT_A.outcome,
      });
      const canonical = stringifyStrictCanonicalSanitizedEvent({ ...EVENT_A });
      assert.notEqual(wrongOrder, canonical);
      await writeEventsRaw(root, `${wrongOrder}\n`);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          return true;
        },
      );
    });
  });

  it('23: missing id JSON line (no sanitize repair) → event-invalid', async () => {
    await withTempRoot('ev-missing-id', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const noId = {
        createdAt: EVENT_A.createdAt,
        type: EVENT_A.type,
        method: EVENT_A.method,
        path: EVENT_A.path,
        outcome: EVENT_A.outcome,
      };
      await writeEventsRaw(root, `${JSON.stringify(noId)}\n`);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
            root,
          );
          return true;
        },
      );
    });
  });

  it('24: per-line >16050 (before JSON.parse) → bounds-exceeded', async () => {
    await withTempRoot('ev-line-bytes', async (root) => {
      const {
        AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
        verifyAuditIntegrityAgainstEventStore,
      } = await loadCrossStore();
      const huge = `${'a'.repeat(AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES + 1)}\n`;
      assert.equal(
        Buffer.byteLength(huge.slice(0, -1), 'utf8'),
        AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES + 1,
      );
      await writeEventsRaw(root, huge);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
            root,
          );
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
          return true;
        },
      );
    });
  });

  it('25: lines >8192 → bounds-exceeded (short stub lines)', async () => {
    await withTempRoot('ev-line-count', async (root) => {
      const {
        AUDIT_CROSS_STORE_MAX_EVENT_LINES,
        verifyAuditIntegrityAgainstEventStore,
      } = await loadCrossStore();
      const n = AUDIT_CROSS_STORE_MAX_EVENT_LINES + 1;
      const many = `${'x\n'.repeat(n)}`;
      await writeEventsRaw(root, many);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
            root,
          );
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR);
          return true;
        },
      );
    });
  });

  it('26: size >16MiB read → io-error (≠ bounds)', async () => {
    await withTempRoot('ev-size-io', async (root) => {
      const {
        AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES,
        verifyAuditIntegrityAgainstEventStore,
      } = await loadCrossStore();
      const oversize = `${'x'.repeat(AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES + 1)}\n`;
      await writeEventsRaw(root, oversize);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
            root,
          );
          assert.notEqual(
            error.code,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
          );
          return true;
        },
      );
    });
  });

  it('27: journal broken/bounds/io rethrow typed as-is; not swallowed to empty/partial', async () => {
    // chain-broken
    await withTempRoot('j-rethrow-broken', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), 'not-a-journal\n', { mode: 0o600 });
      await writeEventsLines(root, [{ ...EVENT_A }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assert.equal(error.name, 'AuditIntegrityJournalError');
          assert.equal(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          assert.equal(error.message, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          assert.ok(!error.message.includes(root));
          return true;
        },
      );
    });

    // journal bounds (single oversize line)
    await withTempRoot('j-rethrow-bounds', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const {
        AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES,
      } = await loadJournal();
      await mkdir(join(root, 'audit'), { recursive: true });
      const hugeLine = `${'a'.repeat(AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES + 1)}\n`;
      await writeFile(journalAbs(root), hugeLine, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assert.equal(error.name, 'AuditIntegrityJournalError');
          assert.equal(error.code, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
          assert.equal(error.message, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
          return true;
        },
      );
    });

    // journal io (pre-read size overlimit)
    await withTempRoot('j-rethrow-io', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const { AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES } = await loadJournal();
      await mkdir(join(root, 'audit'), { recursive: true });
      const oversize = `${'x'.repeat(AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES + 1)}\n`;
      await writeFile(journalAbs(root), oversize, { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assert.equal(error.name, 'AuditIntegrityJournalError');
          assert.equal(error.code, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          assert.equal(error.message, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Receipt contract + options hostile (item 28 + extras)
// ---------------------------------------------------------------------------

describe('cross-store receipt and options contracts', () => {
  it('28: receipt exact 8-key allowlist; freeze; message===code; path-free; hostile options zero traps', async () => {
    await withTempRoot('receipt-opts', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const {
        verifyAuditIntegrityAgainstEventStore,
        AuditIntegrityCrossStoreError,
      } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      await writeEventsLines(root, [{ ...EVENT_A }]);

      const { options, counts } = makeHostileOptions();
      const receipt = await verifyAuditIntegrityAgainstEventStore(root, options);
      assert.deepEqual(Object.keys(receipt), [...RECEIPT_KEYS]);
      assert.equal(Object.keys(receipt).length, 8);
      assert.ok(!('ok' in receipt));
      assert.ok(!('raw' in receipt));
      assert.ok(!('digests' in receipt));
      assert.ok(!('path' in receipt));
      assert.ok(!('body' in receipt));
      assert.equal(Object.isFrozen(receipt), true);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'equal',
        generationId: GENERATION_ID,
        headDigest: a1.headDigest,
        journalEventCount: 1,
        retainedEventCount: 1,
        matchedEventCount: 1,
        uncoveredEventCount: 0,
      });
      // Hostile options: every trap count must be 0 (void options; no try/catch fallback).
      assert.equal(counts.get, 0);
      assert.equal(counts.has, 0);
      assert.equal(counts.ownKeys, 0);
      assert.equal(counts.getOwnPropertyDescriptor, 0);
      assert.equal(counts.set, 0);

      // Error class contract: message===code; registered; path-free
      const err = new AuditIntegrityCrossStoreError(
        ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
      );
      assert.equal(err.message, err.code);
      assert.equal(err.name, 'AuditIntegrityCrossStoreError');
      assert.ok(!String(err.message).includes(root));
    });
  });

  it('missing journal only (NOT_INITIALIZED) swallows to J=[]; other journal typed preserved', async () => {
    await withTempRoot('missing-j-only', async (root) => {
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      // no journal file, no events → 1a
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(receipt.relationship, 'empty');
      assert.equal(receipt.generationId, null);
      assert.equal(receipt.headDigest, null);
    });
  });

  it('invalid root maps to cross-store io-error path-free (not journal codes)', async () => {
    const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
    const badRoot = join(tmpdir(), 'linke-xstore-no-such-root-definitely-missing');
    await assert.rejects(
      () => verifyAuditIntegrityAgainstEventStore(badRoot),
      (error) => {
        assertCrossStoreError(
          error,
          ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
          badRoot,
        );
        return true;
      },
    );
  });

  it('exports minimal public surface names and class', async () => {
    const mod = await loadCrossStore();
    assert.equal(typeof mod.verifyAuditIntegrityAgainstEventStore, 'function');
    assert.equal(typeof mod.AuditIntegrityCrossStoreError, 'function');
    assert.equal(mod.AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH, 'audit/events.jsonl');
    assert.equal(mod.AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES, 16_777_216);
    assert.equal(mod.AUDIT_CROSS_STORE_MAX_EVENT_LINES, 8192);
    assert.equal(mod.AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES, 16050);
  });
});

// ---------------------------------------------------------------------------
// C3 / Task4.1 — honest limitations (PASS = verified|partial; never broken)
// ---------------------------------------------------------------------------

describe('cross-store documents-* honest limitations', () => {
  it('documents-retention-suffix-is-verified-structure-only', async () => {
    // Structure-only: retention-style E suffix of J is verified. This proves
    // payloadDigest sequence compatibility only — NOT deletion authorization,
    // retention policy compliance, or that dropped prefix events were approved.
    await withTempRoot('doc-retention', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      const a3 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_C },
      });
      // E retains only the last 2 of 3 journaled events (retention compact shape).
      await writeEventsLines(root, [{ ...EVENT_B }, { ...EVENT_C }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'events-suffix-of-journal',
        generationId: GENERATION_ID,
        headDigest: a3.headDigest,
        journalEventCount: 3,
        retainedEventCount: 2,
        matchedEventCount: 2,
        uncoveredEventCount: 0,
      });
    });
  });

  it('documents-legacy-prefix-is-partial-not-broken', async () => {
    // Legacy prefix on E with matching J suffix is partial (coverage gap), not broken.
    await withTempRoot('doc-legacy', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      await writeEventsLines(root, [{ ...EVENT_0 }, { ...EVENT_A }, { ...EVENT_B }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'partial',
        relationship: 'journal-suffix-of-events',
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        journalEventCount: 2,
        retainedEventCount: 3,
        matchedEventCount: 2,
        uncoveredEventCount: 1,
      });
    });
  });

  it('documents-uncovered-prefix-mutation-still-partial', async () => {
    // Mutating only the uncovered E prefix (non-overlap) remains partial, not broken.
    await withTempRoot('doc-prefix-mut', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      // Baseline: legacy prefix + matching suffix → partial.
      await writeEventsLines(root, [{ ...EVENT_0 }, { ...EVENT_A }, { ...EVENT_B }]);
      const before = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(before.state, 'partial');
      assert.equal(before.relationship, 'journal-suffix-of-events');

      // Mutate only the uncovered prefix event (overlap A,B unchanged).
      await writeEventsLines(root, [
        { ...EVENT_0, path: '/api/legacy-mutated' },
        { ...EVENT_A },
        { ...EVENT_B },
      ]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'partial',
        relationship: 'journal-suffix-of-events',
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        journalEventCount: 2,
        retainedEventCount: 3,
        matchedEventCount: 2,
        uncoveredEventCount: 1,
      });
    });
  });

  it('documents-paired-rewrite-of-events-and-journal-may-verify', async () => {
    // If both stores are rewritten together to a new equal sequence, verifier may
    // still report verified equal (structural only; not authenticity).
    await withTempRoot('doc-paired-rewrite', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      const original = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(original.state, 'verified');
      assert.equal(original.relationship, 'equal');

      // Paired rewrite: replace both sides with a new equal sequence [C].
      await rm(journalAbs(root), { force: true });
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const c1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_C },
      });
      await writeEventsLines(root, [{ ...EVENT_C }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'equal',
        generationId: GENERATION_ID,
        headDigest: c1.headDigest,
        journalEventCount: 1,
        retainedEventCount: 1,
        matchedEventCount: 1,
        uncoveredEventCount: 0,
      });
    });
  });

  it('documents-consistent-dual-suffix-truncation-may-verify', async () => {
    // Truncating both stores to the same remaining suffix may still verify.
    await withTempRoot('doc-dual-trunc', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_C } });
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }, { ...EVENT_C }]);
      const full = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(full.state, 'verified');
      assert.equal(full.relationship, 'equal');

      // Dual-suffix truncation: both sides keep only [B,C].
      await rm(journalAbs(root), { force: true });
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      const c2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_C },
      });
      await writeEventsLines(root, [{ ...EVENT_B }, { ...EVENT_C }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'equal',
        generationId: GENERATION_ID,
        headDigest: c2.headDigest,
        journalEventCount: 2,
        retainedEventCount: 2,
        matchedEventCount: 2,
        uncoveredEventCount: 0,
      });
    });
  });

  it('documents-journal-only-events-mutation-still-invisible-to-journal-verify', async () => {
    // Events-only mutation: journal verify still succeeds; only explicit cross-store
    // verifier reports broken. Proves V1.36 visibility is limited to this API call.
    await withTempRoot('doc-ev-mut-invisible', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await writeEventsLines(root, [{ ...EVENT_A }]);

      // Mutate events store only (overlap mismatch).
      await writeEventsLines(root, [{ ...EVENT_A, path: '/api/a-mutated' }]);

      const journalVerify = await verifyAuditIntegrityJournalFile(root);
      assert.equal(journalVerify.state, 'verified');
      assert.equal(typeof journalVerify.headDigest, 'string');
      assert.equal(journalVerify.headDigest.length, 64);

      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('documents-full-j-replay-shaped-tail-is-partial-not-broken', async () => {
    // Forced shape: E = J + J (full unjournaled replay of entire J payloadDigest
    // value sequence; no extra legacy prefix). Pure value comparison identifies the
    // last J as a journal suffix → partial journal-suffix-of-events.
    // V1.36 has no writer cursor / baseline / unique occurrence binding, so it cannot
    // distinguish two identical occurrences and MUST NOT claim coverage of every
    // unjournaled tail. Closing this ambiguity is V1.37+ cursor/idempotency work.
    // This case must remain partial — never expect broken.
    await withTempRoot('doc-j-replay', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const a1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const a2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      const snap = await inspectAuditIntegrityJournalFile(root);
      const J = snap.payloadDigests;
      assert.equal(J.length, 2);
      assert.equal(J[0], a1.payloadDigest);
      assert.equal(J[1], a2.payloadDigest);

      // E = J + J via real events file (same strict events, twice).
      await writeEventsLines(root, [
        { ...EVENT_A },
        { ...EVENT_B },
        { ...EVENT_A },
        { ...EVENT_B },
      ]);

      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'partial',
        relationship: 'journal-suffix-of-events',
        generationId: GENERATION_ID,
        headDigest: a2.headDigest,
        journalEventCount: J.length,
        retainedEventCount: J.length * 2,
        matchedEventCount: J.length,
        uncoveredEventCount: J.length,
      });
      // Explicit count lock for E=J+J: matched=J.length, uncovered=J.length.
      assert.equal(receipt.matchedEventCount, 2);
      assert.equal(receipt.uncoveredEventCount, 2);
      assert.equal(receipt.matchedEventCount + receipt.uncoveredEventCount, receipt.retainedEventCount);
    });
  });
});

// ---------------------------------------------------------------------------
// C3 / Task4.2 — hostile broken canaries + positive repeated-digest suffix
// ---------------------------------------------------------------------------

describe('cross-store hostile canaries and repeated-digest suffix truth', () => {
  it('hostile-prefix-not-suffix: E proper prefix of J is broken (not events-suffix)', async () => {
    await withTempRoot('hostile-prefix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_C } });
      // E = proper prefix [A,B] of J=[A,B,C] — not a suffix.
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('hostile-same-multiset-different-order: permutation is broken (not set-equal)', async () => {
    await withTempRoot('hostile-multiset', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_C } });
      // Same multiset, different order.
      await writeEventsLines(root, [{ ...EVENT_C }, { ...EVENT_A }, { ...EVENT_B }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('hostile-same-count-same-last-digest-middle-wrong: middle mismatch is broken', async () => {
    await withTempRoot('hostile-middle', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        computeAuditIntegrityEventPayloadDigest,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_C } });

      // Same length, same last digest (C), wrong middle (0 instead of B).
      const lastOk = computeAuditIntegrityEventPayloadDigest({ ...EVENT_C });
      const middleWrong = computeAuditIntegrityEventPayloadDigest({ ...EVENT_0 });
      const middleRight = computeAuditIntegrityEventPayloadDigest({ ...EVENT_B });
      assert.equal(lastOk, computeAuditIntegrityEventPayloadDigest({ ...EVENT_C }));
      assert.notEqual(middleWrong, middleRight);

      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_0 }, { ...EVENT_C }]);
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('hostile-repeated-digest-non-suffix: J=[x,y,x] E=[x,x] is broken (index-by-index)', async () => {
    // Real non-suffix canary: J last two are [y,x], E is [x,x] → not a suffix.
    // Must use real journal/events files + public verifier (not local array helpers).
    // Repeat-append same strict event yields identical payloadDigest values.
    await withTempRoot('hostile-rep-nonsuffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
        computeAuditIntegrityEventPayloadDigest,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();

      const digX = computeAuditIntegrityEventPayloadDigest({ ...EVENT_A });
      const digY = computeAuditIntegrityEventPayloadDigest({ ...EVENT_B });
      assert.notEqual(digX, digY);

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      // J = [x, y, x] via append x, y, x (same EVENT_A twice).
      const r1 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      const r2 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });
      const r3 = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_A },
      });
      assert.equal(r1.payloadDigest, digX);
      assert.equal(r2.payloadDigest, digY);
      assert.equal(r3.payloadDigest, digX);

      const snap = await inspectAuditIntegrityJournalFile(root);
      const J = snap.payloadDigests;
      assert.equal(J.length, 3);
      assert.equal(J[0], digX);
      assert.equal(J[1], digY);
      assert.equal(J[2], digX);
      // Index-by-index: J tail of length 2 is [y,x], not [x,x].
      assert.equal(J[J.length - 2], digY);
      assert.equal(J[J.length - 1], digX);
      assert.deepEqual([J[1], J[2]], [digY, digX]);
      assert.notDeepEqual([J[1], J[2]], [digX, digX]);

      // E = [x, x] via real events file (same strict event twice).
      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_A }]);

      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('hostile-empty-suffix-guard: J=[x] E=[] is broken (no empty-suffix loophole)', async () => {
    await withTempRoot('hostile-empty-suffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      // Explicit empty events file (E=[]), journal non-empty.
      await writeEventsRaw(root, '');
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assertCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );
    });
  });

  it('positive-repeated-digest-events-suffix: J=[x,x,y] E=[x,y] is verified events-suffix', async () => {
    // True suffix canary: repeated digest values do NOT break index-by-index
    // non-empty proper suffix. J last two [x,y] === E. MUST be verified, not broken.
    await withTempRoot('pos-rep-suffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        inspectAuditIntegrityJournalFile,
        computeAuditIntegrityEventPayloadDigest,
      } = await loadJournal();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();

      const digX = computeAuditIntegrityEventPayloadDigest({ ...EVENT_A });
      const digY = computeAuditIntegrityEventPayloadDigest({ ...EVENT_B });

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      // J = [x, x, y]
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      const last = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...EVENT_B },
      });

      const snap = await inspectAuditIntegrityJournalFile(root);
      const J = snap.payloadDigests;
      assert.equal(J.length, 3);
      assert.equal(J[0], digX);
      assert.equal(J[1], digX);
      assert.equal(J[2], digY);
      // Index-by-index: last two of J equal E = [x, y].
      assert.equal(J[J.length - 2], digX);
      assert.equal(J[J.length - 1], digY);
      assert.deepEqual([J[1], J[2]], [digX, digY]);

      await writeEventsLines(root, [{ ...EVENT_A }, { ...EVENT_B }]);
      const receipt = await verifyAuditIntegrityAgainstEventStore(root);
      assertReceipt(receipt, {
        state: 'verified',
        relationship: 'events-suffix-of-journal',
        generationId: GENERATION_ID,
        headDigest: last.headDigest,
        journalEventCount: 3,
        retainedEventCount: 2,
        matchedEventCount: 2,
        uncoveredEventCount: 0,
      });
    });
  });
});
