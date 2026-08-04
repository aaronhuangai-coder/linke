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
import {
  acknowledgeAuditIntegrityAlertOutboxHead,
  AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_ENTRIES,
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  enqueueAuditIntegrityAlertOutbox,
  readAuditIntegrityAlertOutbox,
} from '../src/audit-integrity-alert-outbox.js';
import { appendAuditEventWithIntegrityDualWrite } from '../src/audit-integrity-dual-write.js';
import {
  AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT,
  runAuditIntegrityMonitor,
} from '../src/audit-integrity-monitor.js';

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

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-alert-outbox-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
