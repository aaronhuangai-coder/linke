/**
 * Outbox foundation + Task 2 RED — public claim exclusion and lease-guarded
 * internal head acknowledgement.
 * Authority:
 *   docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-claim-design.md
 *   docs/superpowers/plans/2026-08-04-audit-integrity-alert-delivery-claim-plan.md
 *
 * Task 2 production surface (absent on old HEAD):
 *   acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, sequence)
 * Public ack must consult claim state under the write lease and refuse every
 * persisted claimed status; only the under-lease primitive may remove head while
 * claimed. Deadline / Date.now never authorizes manual ack.
 *
 * Dynamic export inspection: old HEAD registers exactly one behavior-specific
 * RED named/message `lease-guarded outbox acknowledgement implementation missing`
 * without static missing-export SyntaxError. Full Task 2 matrix registers only
 * when that export exists. Real filesystem + real audit write leases; no mocks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as outboxModule from '../src/audit-integrity-alert-outbox.js';
import {
  AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
  publishAuditIntegrityAlertDeliveryClaimState,
} from '../src/audit-integrity-alert-delivery-claim-state.js';
import { enqueueAuditIntegrityWriteTask } from '../src/audit-integrity-write-queue.js';
import { assertSafeDataRoot } from '../src/safe-data-files.js';
import { appendAuditEventWithIntegrityDualWrite } from '../src/audit-integrity-dual-write.js';
import {
  AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT,
  runAuditIntegrityMonitor,
} from '../src/audit-integrity-monitor.js';

const {
  acknowledgeAuditIntegrityAlertOutboxHead,
  AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_ENTRIES,
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  enqueueAuditIntegrityAlertOutbox,
  readAuditIntegrityAlertOutbox,
} = outboxModule;

/** @type {null | ((resolvedRoot: unknown, lease: unknown, sequence: unknown) => Promise<unknown>)} */
const acknowledgeUnderLeaseExport =
  typeof outboxModule.acknowledgeAuditIntegrityAlertOutboxHeadUnderLease === 'function'
    ? outboxModule.acknowledgeAuditIntegrityAlertOutboxHeadUnderLease
    : null;

const UNDER_LEASE_MISSING_MSG =
  'lease-guarded outbox acknowledgement implementation missing';

const FIXED_CHECKED_AT = '2026-08-04T12:34:56.789Z';
const execFileAsync = promisify(execFile);
const EVENT = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-08-04T12:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

// Literal claim fixtures independent of production serializers (Task 1 grammar).
const CLAIM_ID = 'a1111111-b111-4111-8111-e11111111111';
const STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const OWNER_PID = 4242;
const BOOT_VALUE =
  'boot-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROCESS_VALUE =
  'process-start-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// Wall-clock-unexpired claim window (far future). Public ack must still refuse.
const CLAIMED_AT_FUTURE = '2099-01-01T00:00:00.000Z';
const EXPIRES_AT_FUTURE = '2099-01-01T00:02:00.000Z';
// Wall-clock-expired claim window (far past). Deadline must never authorize manual ack.
const CLAIMED_AT_PAST = '2020-01-01T00:00:00.000Z';
const EXPIRES_AT_PAST = '2020-01-01T00:02:00.000Z';

/** Exact literal canonical idle claim bytes. */
const CANONICAL_IDLE_CLAIM_BYTES =
  '{"schemaVersion":1,"status":"idle","claimId":null,"streamId":null,"sequence":null,"ownerPid":null,"bootSessionIdentity":null,"processStartIdentity":null,"claimedAt":null,"expiresAt":null}\n';

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-alert-outbox-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Run fn under a genuine active same-root audit write lease.
 * @param {string} root
 * @param {(resolvedRoot: string, lease: object) => unknown | Promise<unknown>} fn
 */
async function withActiveLease(root, fn) {
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

/**
 * Publish canonical claim state via Task 1 API under a real lease.
 * @param {string} root
 * @param {object} state
 */
async function publishClaimUnderLease(root, state) {
  return withActiveLease(root, async (resolvedRoot, lease) => {
    return publishAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease, state);
  });
}

async function issuedReport({ healthy = false } = {}) {
  return withTempRoot(healthy ? 'healthy-report' : 'alert-report', async (root) => {
    if (healthy) await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT });
    const options = Object.create(null);
    Object.defineProperty(options, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT, {
      value: FIXED_CHECKED_AT,
      enumerable: false,
    });
    return runAuditIntegrityMonitor(root, options);
  });
}

function assertUnavailable(error) {
  return error
    && error.name === 'LinkeError'
    && error.code === 'audit-delivery-unavailable'
    && error.message === 'audit-delivery-unavailable';
}

function outboxAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
}

function claimAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH);
}

function assertStateShape(state, { nextSequence, sequences }) {
  assert.equal(Object.isFrozen(state), true);
  assert.deepEqual(Object.keys(state), ['schemaVersion', 'nextSequence', 'entries']);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.nextSequence, nextSequence);
  assert.equal(Object.isFrozen(state.entries), true);
  assert.deepEqual(state.entries.map((entry) => entry.sequence), sequences);
  for (const entry of state.entries) {
    assert.equal(Object.isFrozen(entry), true);
    assert.deepEqual(Object.keys(entry), [
      'sequence',
      'checkedAt',
      'code',
      'recoveryRequired',
      'nextAction',
      'reasonCode',
    ]);
  }
}

function canonicalState(nextSequence, entries) {
  return `${JSON.stringify({ schemaVersion: 1, nextSequence, entries })}\n`;
}

function uninitializedEntry(sequence) {
  return {
    sequence,
    checkedAt: FIXED_CHECKED_AT,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
  };
}

function buildIdleClaimObject() {
  return {
    schemaVersion: 1,
    status: 'idle',
    claimId: null,
    streamId: null,
    sequence: null,
    ownerPid: null,
    bootSessionIdentity: null,
    processStartIdentity: null,
    claimedAt: null,
    expiresAt: null,
  };
}

/**
 * Canonical claimed object. Defaults use future (unexpired) wall-clock window
 * and sequence 1 so fixtures line up with a freshly enqueued FIFO head.
 * @param {object} [overrides]
 */
function buildClaimedClaimObject(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'claimed',
    claimId: CLAIM_ID,
    streamId: STREAM_ID,
    sequence: 1,
    ownerPid: OWNER_PID,
    bootSessionIdentity: { available: true, value: BOOT_VALUE },
    processStartIdentity: { available: true, value: PROCESS_VALUE },
    claimedAt: CLAIMED_AT_FUTURE,
    expiresAt: EXPIRES_AT_FUTURE,
    ...overrides,
  };
}

function claimedClaimBytes(overrides = {}) {
  return `${JSON.stringify(buildClaimedClaimObject(overrides))}\n`;
}

// Anchor hand-derived idle claim literal so fixtures cannot drift silently.
assert.equal(CANONICAL_IDLE_CLAIM_BYTES, `${JSON.stringify(buildIdleClaimObject())}\n`);
assert.equal(
  Date.parse(EXPIRES_AT_FUTURE) - Date.parse(CLAIMED_AT_FUTURE),
  120_000,
);
assert.equal(
  Date.parse(EXPIRES_AT_PAST) - Date.parse(CLAIMED_AT_PAST),
  120_000,
);

async function readOptionalRaw(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

describe('audit integrity alert outbox foundation', () => {
  it('rejects a forged report with a fixed error before creating the supplied path', async () => {
    await withTempRoot('forged-zero-fs', async (parent) => {
      const absentRoot = join(parent, 'must-remain-absent');
      const forged = Object.freeze({ status: 'alert', code: 'integrity-alert' });
      await assert.rejects(
        enqueueAuditIntegrityAlertOutbox(absentRoot, forged),
        assertUnavailable,
      );
      await assert.rejects(access(absentRoot), (error) => error.code === 'ENOENT');
    });
  });

  it('rejects hostile report and dataDir Proxies without firing their traps', async () => {
    let traps = 0;
    const hostile = new Proxy(Object.freeze(Object.create(null)), {
      get() { traps += 1; throw new Error('hostile get'); },
      ownKeys() { traps += 1; throw new Error('hostile ownKeys'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('hostile descriptor'); },
      getPrototypeOf() { traps += 1; throw new Error('hostile prototype'); },
    });
    await assert.rejects(
      enqueueAuditIntegrityAlertOutbox(hostile, hostile),
      assertUnavailable,
    );
    assert.equal(traps, 0);
  });

  it('ignores an issued healthy report without requiring an existing data root', async () => {
    const report = await issuedReport({ healthy: true });
    await withTempRoot('healthy-zero-fs', async (parent) => {
      const absentRoot = join(parent, 'must-remain-absent');
      const receipt = await enqueueAuditIntegrityAlertOutbox(absentRoot, report);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'ignored-healthy',
        queued: false,
        sequence: null,
        pendingCount: null,
      });
      assert.equal(Object.isFrozen(receipt), true);
      await assert.rejects(access(absentRoot), (error) => error.code === 'ENOENT');
    });
  });

  it('reads an absent outbox as a frozen empty snapshot without creating it', async () => {
    await withTempRoot('absent-read', async (root) => {
      const state = await readAuditIntegrityAlertOutbox(root);
      assertStateShape(state, { nextSequence: 1, sequences: [] });
      await assert.rejects(access(outboxAbs(root)), (error) => error.code === 'ENOENT');
    });
  });

  it('queues an issued alert and reads the exact sanitized occurrence', async () => {
    const report = await issuedReport();
    await withTempRoot('queue-one', async (root) => {
      const receipt = await enqueueAuditIntegrityAlertOutbox(root, report);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'queued',
        queued: true,
        sequence: 1,
        pendingCount: 1,
      });
      assert.equal(Object.isFrozen(receipt), true);

      const state = await readAuditIntegrityAlertOutbox(root);
      assertStateShape(state, { nextSequence: 2, sequences: [1] });
      assert.deepEqual(state.entries[0], {
        sequence: 1,
        checkedAt: FIXED_CHECKED_AT,
        code: 'uninitialized',
        recoveryRequired: false,
        nextAction: 'initialize-via-production-write',
        reasonCode: null,
      });
      const persisted = await readFile(outboxAbs(root), 'utf8');
      assert.equal(persisted.endsWith('\n'), true);
      assert.equal(persisted.includes('/api/test'), false);
      assert.equal(persisted.includes('11111111-1111-4111-8111-111111111111'), false);
    });
  });

  it('preserves repeated alert occurrences with contiguous unique sequences', async () => {
    const report = await issuedReport();
    await withTempRoot('repeat', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const state = await readAuditIntegrityAlertOutbox(root);
      assertStateShape(state, { nextSequence: 3, sequences: [1, 2] });
    });
  });

  it('acknowledges only the exact head and removes one occurrence atomically', async () => {
    const report = await issuedReport();
    await withTempRoot('ack-head', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await assert.rejects(
        acknowledgeAuditIntegrityAlertOutboxHead(root, 2),
        assertUnavailable,
      );
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [1, 2],
      });

      const receipt = await acknowledgeAuditIntegrityAlertOutboxHead(root, 1);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'acknowledged',
        acknowledged: true,
        sequence: 1,
        pendingCount: 1,
      });
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [2],
      });
    });
  });

  it('returns empty acknowledgement without creating absent outbox state', async () => {
    await withTempRoot('ack-empty', async (root) => {
      const receipt = await acknowledgeAuditIntegrityAlertOutboxHead(root, 1);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'empty',
        acknowledged: false,
        sequence: null,
        pendingCount: 0,
      });
      assert.equal(Object.isFrozen(receipt), true);
      await assert.rejects(access(outboxAbs(root)), (error) => error.code === 'ENOENT');
    });
  });

  it('rejects invalid acknowledgement sequence before creating the supplied path', async () => {
    await withTempRoot('ack-invalid-zero-fs', async (parent) => {
      const absentRoot = join(parent, 'must-remain-absent');
      for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        await assert.rejects(
          acknowledgeAuditIntegrityAlertOutboxHead(absentRoot, sequence),
          assertUnavailable,
        );
      }
      await assert.rejects(access(absentRoot), (error) => error.code === 'ENOENT');
    });
  });

  it('serializes same-root concurrent enqueues without losing occurrences', async () => {
    const report = await issuedReport();
    await withTempRoot('concurrent', async (root) => {
      await Promise.all(Array.from(
        { length: 8 },
        () => enqueueAuditIntegrityAlertOutbox(root, report),
      ));
      const state = await readAuditIntegrityAlertOutbox(root);
      assertStateShape(state, {
        nextSequence: 9,
        sequences: [1, 2, 3, 4, 5, 6, 7, 8],
      });
    });
  });

  it('serializes independent child-process enqueues into contiguous occurrences', async () => {
    await withTempRoot('multiprocess', async (root) => {
      const script = [
        "import { runAuditIntegrityMonitor } from './src/audit-integrity-monitor.js';",
        "import { enqueueAuditIntegrityAlertOutbox } from './src/audit-integrity-alert-outbox.js';",
        'const report = await runAuditIntegrityMonitor(process.argv[1]);',
        'await enqueueAuditIntegrityAlertOutbox(process.argv[1], report);',
      ].join('\n');
      await Promise.all(Array.from({ length: 4 }, () => execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script, root],
        { cwd: join(import.meta.dirname, '..'), timeout: 15_000 },
      )));
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 5,
        sequences: [1, 2, 3, 4],
      });
    });
  });

  it('fails closed on full capacity without changing persisted bytes', async () => {
    const report = await issuedReport();
    await withTempRoot('capacity', async (root) => {
      const entries = Array.from(
        { length: AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_ENTRIES },
        (_, i) => uninitializedEntry(i + 1),
      );
      const raw = canonicalState(257, entries);
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(outboxAbs(root), raw, { encoding: 'utf8', mode: 0o600 });

      await assert.rejects(enqueueAuditIntegrityAlertOutbox(root, report), assertUnavailable);
      assert.equal(await readFile(outboxAbs(root), 'utf8'), raw);
    });
  });

  it('fails closed on corrupt state without resetting or rewriting it', async () => {
    await withTempRoot('corrupt', async (root) => {
      const raw = '{"schemaVersion":1,"nextSequence":2,"entries":BROKEN}\n';
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(outboxAbs(root), raw, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(readAuditIntegrityAlertOutbox(root), assertUnavailable);
      assert.equal(await readFile(outboxAbs(root), 'utf8'), raw);
    });
  });

  it('rejects extra keys, gaps, duplicates, semantic contradictions, and noncanonical bytes', async () => {
    const variants = [
      `${JSON.stringify({ schemaVersion: 1, nextSequence: 2, entries: [uninitializedEntry(1)], extra: true })}\n`,
      canonicalState(4, [uninitializedEntry(1), uninitializedEntry(3)]),
      canonicalState(2, [uninitializedEntry(1), uninitializedEntry(1)]),
      canonicalState(2, [{ ...uninitializedEntry(1), recoveryRequired: true }]),
      `${JSON.stringify({ schemaVersion: 1, nextSequence: 2, entries: [uninitializedEntry(1)] }, null, 2)}\n`,
    ];
    for (const [index, raw] of variants.entries()) {
      await withTempRoot(`invalid-${index}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(outboxAbs(root), raw, { encoding: 'utf8', mode: 0o600 });
        await assert.rejects(readAuditIntegrityAlertOutbox(root), assertUnavailable);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), raw);
      });
    }
  });

  it('fails closed on a symlink leaf without modifying its target', async () => {
    await withTempRoot('symlink', async (root) => {
      const target = join(root, 'target.json');
      const raw = canonicalState(1, []);
      await writeFile(target, raw, { encoding: 'utf8', mode: 0o600 });
      await mkdir(join(root, 'audit'), { recursive: true });
      await symlink(target, outboxAbs(root));
      await assert.rejects(readAuditIntegrityAlertOutbox(root), assertUnavailable);
      assert.equal(await readFile(target, 'utf8'), raw);
    });
  });

  it('fails closed before sequence overflow and preserves the valid state', async () => {
    const report = await issuedReport();
    await withTempRoot('sequence-overflow', async (root) => {
      const raw = canonicalState(
        Number.MAX_SAFE_INTEGER,
        [uninitializedEntry(Number.MAX_SAFE_INTEGER - 1)],
      );
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(outboxAbs(root), raw, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(enqueueAuditIntegrityAlertOutbox(root, report), assertUnavailable);
      assert.equal(await readFile(outboxAbs(root), 'utf8'), raw);
    });
  });

  it('fails closed on an oversized state file without rewriting it', async () => {
    await withTempRoot('oversize', async (root) => {
      const raw = `{"padding":"${'x'.repeat(1024 * 1024)}"}\n`;
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(outboxAbs(root), raw, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(readAuditIntegrityAlertOutbox(root), assertUnavailable);
      assert.equal((await readFile(outboxAbs(root))).length, Buffer.byteLength(raw));
    });
  });

  it('source keeps monitor composition external and has no network, timer, CLI, or direct lock path', async () => {
    const source = await readFile(
      new URL('../src/audit-integrity-alert-outbox.js', import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      'runAuditIntegrityMonitor',
      'acquireAuditIntegrityProcessLock',
      'node:http',
      'node:https',
      'fetch(',
      'setInterval(',
      'setTimeout(',
      'process.argv',
      'child_process',
      'launchctl',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden source surface: ${forbidden}`);
    }
    assert.equal(source.includes('enqueueAuditIntegrityWriteTask'), true);
    assert.equal(source.includes('safeAtomicWriteText'), true);
  });
});

describe('lease-guarded outbox acknowledgement and public claim exclusion (Task 2 RED)', () => {
  // Old HEAD: exactly one dedicated behavior-specific RED. Full matrix only when export exists.
  if (acknowledgeUnderLeaseExport === null) {
    it('lease-guarded outbox acknowledgement implementation missing', () => {
      assert.fail(UNDER_LEASE_MISSING_MSG);
    });
    return;
  }

  const acknowledgeAuditIntegrityAlertOutboxHeadUnderLease = acknowledgeUnderLeaseExport;

  it('public ack with missing claim state removes only head and returns exact receipt', async () => {
    // Break: missing-claim path must keep legacy head-ack success; claim leaf stays absent.
    const report = await issuedReport();
    await withTempRoot('t2-public-missing-claim', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await assert.rejects(access(claimAbs(root)), (error) => error.code === 'ENOENT');
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');

      const receipt = await acknowledgeAuditIntegrityAlertOutboxHead(root, 1);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'acknowledged',
        acknowledged: true,
        sequence: 1,
        pendingCount: 1,
      });
      assert.equal(Object.isFrozen(receipt), true);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [2],
      });
      assert.notEqual(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      await assert.rejects(access(claimAbs(root)), (error) => error.code === 'ENOENT');
    });
  });

  it('public ack with persisted idle claim succeeds, removes only head, and leaves exact idle claim bytes unchanged', async () => {
    // Break: idle claim must not block manual ack; claim bytes must be byte-identical after.
    const report = await issuedReport();
    await withTempRoot('t2-public-idle-claim', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await publishClaimUnderLease(root, buildIdleClaimObject());
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimBefore, CANONICAL_IDLE_CLAIM_BYTES);

      const receipt = await acknowledgeAuditIntegrityAlertOutboxHead(root, 1);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'acknowledged',
        acknowledged: true,
        sequence: 1,
        pendingCount: 1,
      });
      assert.equal(Object.isFrozen(receipt), true);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [2],
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
    });
  });

  it('public ack rejects unexpired claimed state without mutating outbox or claim bytes', async () => {
    // Break: omitting assertNo… / restoring pre-lock empty path would let manual ack steal claimed head.
    const report = await issuedReport();
    await withTempRoot('t2-public-claimed-unexpired', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const expectedClaim = claimedClaimBytes({
        sequence: 1,
        claimedAt: CLAIMED_AT_FUTURE,
        expiresAt: EXPIRES_AT_FUTURE,
      });
      await publishClaimUnderLease(root, buildClaimedClaimObject({
        sequence: 1,
        claimedAt: CLAIMED_AT_FUTURE,
        expiresAt: EXPIRES_AT_FUTURE,
      }));
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimBefore, expectedClaim);

      await assert.rejects(
        acknowledgeAuditIntegrityAlertOutboxHead(root, 1),
        assertUnavailable,
      );

      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [1, 2],
      });
    });
  });

  it('public ack rejects expired claimed state without mutating outbox or claim bytes (deadline never authorizes)', async () => {
    // Break: checking expiry / Date.now to allow past-deadline manual ack would unfence a live claim.
    const report = await issuedReport();
    await withTempRoot('t2-public-claimed-expired', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const expectedClaim = claimedClaimBytes({
        sequence: 1,
        claimedAt: CLAIMED_AT_PAST,
        expiresAt: EXPIRES_AT_PAST,
      });
      await publishClaimUnderLease(root, buildClaimedClaimObject({
        sequence: 1,
        claimedAt: CLAIMED_AT_PAST,
        expiresAt: EXPIRES_AT_PAST,
      }));
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimBefore, expectedClaim);

      await assert.rejects(
        acknowledgeAuditIntegrityAlertOutboxHead(root, 1),
        assertUnavailable,
      );

      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [1, 2],
      });
    });
  });

  it('public ack rejects claimed state when outbox is absent (no empty fast-path bypass)', async () => {
    // Break: restoring public ack pre-lock empty return skips claim exclusion on empty/absent outbox.
    await withTempRoot('t2-public-claimed-absent-outbox', async (root) => {
      const expectedClaim = claimedClaimBytes({ sequence: 1 });
      await publishClaimUnderLease(root, buildClaimedClaimObject({ sequence: 1 }));
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimBefore, expectedClaim);
      await assert.rejects(access(outboxAbs(root)), (error) => error.code === 'ENOENT');

      await assert.rejects(
        acknowledgeAuditIntegrityAlertOutboxHead(root, 1),
        assertUnavailable,
      );

      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
      await assert.rejects(access(outboxAbs(root)), (error) => error.code === 'ENOENT');
    });
  });

  it('public ack rejects claimed state when outbox is empty (no empty fast-path bypass)', async () => {
    // Break: empty-outbox short-circuit before assertNo would return empty while a claim is live.
    await withTempRoot('t2-public-claimed-empty-outbox', async (root) => {
      const emptyOutbox = canonicalState(1, []);
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(outboxAbs(root), emptyOutbox, { encoding: 'utf8', mode: 0o600 });
      const expectedClaim = claimedClaimBytes({ sequence: 1 });
      await publishClaimUnderLease(root, buildClaimedClaimObject({ sequence: 1 }));
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(outboxBefore, emptyOutbox);
      assert.equal(claimBefore, expectedClaim);

      await assert.rejects(
        acknowledgeAuditIntegrityAlertOutboxHead(root, 1),
        assertUnavailable,
      );

      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
    });
  });

  it('under-lease ack removes only the exact FIFO head and returns the exact frozen receipt', async () => {
    // Break: deleting a non-head or wrong slice would reorder / drop successor occurrences.
    const report = await issuedReport();
    await withTempRoot('t2-under-lease-head', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);

      const receipt = await withActiveLease(root, async (resolvedRoot, lease) => {
        return acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, 1);
      });
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'acknowledged',
        acknowledged: true,
        sequence: 1,
        pendingCount: 1,
      });
      assert.equal(Object.isFrozen(receipt), true);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [2],
      });
    });
  });

  it('under-lease ack rejects non-head sequence without mutating outbox bytes', async () => {
    // Break: accepting a non-head sequence would remove a successor head under a stale claim.
    const report = await issuedReport();
    await withTempRoot('t2-under-lease-non-head', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');

      await assert.rejects(
        withActiveLease(root, async (resolvedRoot, lease) => {
          return acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, 2);
        }),
        assertUnavailable,
      );

      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [1, 2],
      });
    });
  });

  it('under-lease ack may remove head while claimed is persisted and must not modify claim bytes', async () => {
    // Break: delivery-completion primitive must fence claim file; only outbox head is removed.
    const report = await issuedReport();
    await withTempRoot('t2-under-lease-with-claim', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const expectedClaim = claimedClaimBytes({ sequence: 1 });
      await publishClaimUnderLease(root, buildClaimedClaimObject({ sequence: 1 }));
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimBefore, expectedClaim);

      const receipt = await withActiveLease(root, async (resolvedRoot, lease) => {
        return acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, 1);
      });
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'acknowledged',
        acknowledged: true,
        sequence: 1,
        pendingCount: 1,
      });
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [2],
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), expectedClaim);
    });
  });

  it('under-lease ack fails closed for missing, forged, wrong-root, and expired leases before outbox mutation', async () => {
    // Break: accepting a forged/expired/wrong-root lease would allow out-of-queue head removal.
    const report = await issuedReport();
    await withTempRoot('t2-under-lease-lease-guards', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');
      const claimBefore = await readOptionalRaw(claimAbs(root));
      const resolvedRoot = await assertSafeDataRoot(root);

      for (const lease of [null, undefined, Object.freeze({}), Object.freeze({ forged: true })]) {
        await assert.rejects(
          () => acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, 1),
          assertUnavailable,
        );
      }

      await withTempRoot('t2-under-lease-wrong-root-b', async (rootB) => {
        await withActiveLease(rootB, async (_resolvedB, leaseFromB) => {
          await assert.rejects(
            () => acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
              resolvedRoot,
              leaseFromB,
              1,
            ),
            assertUnavailable,
          );
        });
      });

      let expiredLease = null;
      await withActiveLease(root, async (_resolved, lease) => {
        expiredLease = lease;
      });
      assert.notEqual(expiredLease, null);
      await assert.rejects(
        () => acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
          resolvedRoot,
          expiredLease,
          1,
        ),
        assertUnavailable,
      );

      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assert.equal(await readOptionalRaw(claimAbs(root)), claimBefore);
      assertStateShape(await readAuditIntegrityAlertOutbox(root), {
        nextSequence: 3,
        sequences: [1, 2],
      });
    });
  });

  it('under-lease ack on empty outbox returns exact empty receipt and creates no outbox leaf', async () => {
    // Break: empty path under a valid lease must not create a leaf or invent a non-empty receipt.
    await withTempRoot('t2-under-lease-empty', async (root) => {
      await assert.rejects(access(outboxAbs(root)), (error) => error.code === 'ENOENT');

      const receipt = await withActiveLease(root, async (resolvedRoot, lease) => {
        return acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, 1);
      });
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'empty',
        acknowledged: false,
        sequence: null,
        pendingCount: 0,
      });
      assert.equal(Object.isFrozen(receipt), true);
      await assert.rejects(access(outboxAbs(root)), (error) => error.code === 'ENOENT');
    });
  });

  it('under-lease ack rejects invalid sequence without mutating outbox or claim bytes', async () => {
    // Break: unsafe/non-positive sequences must fail closed before any publish.
    const report = await issuedReport();
    await withTempRoot('t2-under-lease-invalid-seq', async (root) => {
      await enqueueAuditIntegrityAlertOutbox(root, report);
      const expectedClaim = claimedClaimBytes({ sequence: 1 });
      await publishClaimUnderLease(root, buildClaimedClaimObject({ sequence: 1 }));
      const outboxBefore = await readFile(outboxAbs(root), 'utf8');
      const claimBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimBefore, expectedClaim);

      await withActiveLease(root, async (resolvedRoot, lease) => {
        for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
          await assert.rejects(
            () => acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
              resolvedRoot,
              lease,
              sequence,
            ),
            assertUnavailable,
          );
        }
      });

      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), claimBefore);
    });
  });

  it('source wires claim exclusion and under-lease primitive without Date.now, nested enqueue, or claim mutation', async () => {
    // Break: realistic partial mutations — omit assertNo, nest enqueue, Date.now expiry, claim write.
    const source = await readFile(
      new URL('../src/audit-integrity-alert-outbox.js', import.meta.url),
      'utf8',
    );
    assert.equal(
      source.includes('acknowledgeAuditIntegrityAlertOutboxHeadUnderLease'),
      true,
    );
    assert.equal(
      source.includes('assertNoAuditIntegrityAlertDeliveryClaim'),
      true,
    );
    assert.equal(source.includes('Date.now'), false);
    // Under-lease primitive is the narrow completion path: it must not re-enter the queue.
    // Match only that function (until the next top-level export or EOF) so a later public
    // ack that correctly uses enqueue does not false-fail this guard.
    const underLeaseFn = source.match(
      /export\s+async\s+function\s+acknowledgeAuditIntegrityAlertOutboxHeadUnderLease[\s\S]*?(?=\nexport\s|$)/,
    );
    assert.notEqual(underLeaseFn, null);
    assert.equal(
      underLeaseFn[0].includes('enqueueAuditIntegrityWriteTask'),
      false,
    );
    // Claim file must only be consulted via assertNo on the public path, never rewritten here.
    assert.equal(
      source.includes('integrity-alert-delivery-claim.json'),
      false,
    );
    assert.equal(
      source.includes('publishAuditIntegrityAlertDeliveryClaimState'),
      false,
    );
  });
});
