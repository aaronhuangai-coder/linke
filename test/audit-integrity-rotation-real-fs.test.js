/**
 * Linke V1.43 Task 8 — real filesystem and SIGKILL recovery acceptance F1-F6.
 *
 * All roots are isolated under mkdtemp(tmpdir()). F3-F6 run a real independent
 * Node child, wait for a durable checkpoint marker, deliver SIGKILL, and recover
 * through a fresh `node src/agent.js` process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendAuditEventWithIntegrityDualWrite,
  recoverAuditIntegrityDualWrite,
} from '../src/audit-integrity-dual-write.js';
import { parseAuditIntegrityDualWriteStateText } from '../src/audit-integrity-dual-write-state.js';
import {
  AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK,
  recoverAuditIntegrityRotation,
  rotateAuditIntegrityGeneration,
} from '../src/audit-integrity-rotation.js';
import {
  buildAuditIntegrityArchiveManifest,
  parseAuditIntegrityArchiveManifestText,
  parseAuditIntegrityRotationStateText,
} from '../src/audit-integrity-rotation-state.js';
import { verifyAuditIntegrityAgainstEventStore } from '../src/audit-integrity-cross-store.js';
import { runAuditIntegrityMonitor } from '../src/audit-integrity-monitor.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const CHILD_SRC = join(REPO_ROOT, 'test', 'helpers', 'audit-integrity-rotation-child.js');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const LOCKF_OK = process.platform === 'darwin' && existsSync('/usr/bin/lockf');
const describeReal = LOCKF_OK ? describe : describe.skip;

const BARRIER_LEAF = '.linke-rotation-child-go';
const CHILD_READY_MS = 30_000;
const CHILD_CRASH_MS = 60_000;
const CHILD_EXIT_MS = 15_000;

const CRASH_CASES = Object.freeze({
  CP3: Object.freeze({ status: 'prepared' }),
  CP4: Object.freeze({ status: 'archive-committed' }),
  CP5: Object.freeze({ status: 'journal-published' }),
  CP6: Object.freeze({ status: 'events-published' }),
});

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

const EVENT_AFTER_RECOVERY = Object.freeze({
  id: '44444444-4444-4444-8444-444444444444',
  createdAt: '2026-07-21T00:00:00.000Z',
  type: 'api.test.after-recovery',
  method: 'POST',
  path: '/api/after-recovery',
  outcome: 'success',
});

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

function dualStateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function rotationStateAbs(root) {
  return join(root, 'audit', 'integrity-rotation-state.json');
}

function archiveRootAbs(root) {
  return join(root, 'audit', 'archive');
}

function archiveDirAbs(root, generationId) {
  return join(archiveRootAbs(root), generationId);
}

function archiveJournalAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'integrity-journal.jsonl');
}

function archiveEventsAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'events.jsonl');
}

function archiveManifestAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'manifest.json');
}

function barrierAbs(root) {
  return join(root, BARRIER_LEAF);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function childEnv() {
  const env = {};
  if (typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  if (typeof process.env.TMPDIR === 'string') env.TMPDIR = process.env.TMPDIR;
  return env;
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-rotation-fs-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function createHealthyIdle(root) {
  await recoverAuditIntegrityDualWrite(root);
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
  const idle = parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  return {
    generationId: idle.generationId,
    headDigest: idle.journal.headDigest,
    journalBytes: await readFile(journalAbs(root)),
    eventsBytes: await readFile(eventsAbs(root)),
    dualBytes: await readFile(dualStateAbs(root)),
  };
}

async function snapshotLive(root) {
  return {
    journal: await readOptional(journalAbs(root)),
    events: await readOptional(eventsAbs(root)),
    dual: await readOptional(dualStateAbs(root)),
    rotation: await readOptional(rotationStateAbs(root)),
    archivePresent: await pathExists(archiveRootAbs(root)),
  };
}

function assertLiveEqual(actual, expected) {
  assert.deepEqual(actual.journal, expected.journal);
  assert.deepEqual(actual.events, expected.events);
  assert.deepEqual(actual.dual, expected.dual);
  assert.deepEqual(actual.rotation, expected.rotation);
  assert.equal(actual.archivePresent, expected.archivePresent);
}

function assertLiveDataEqual(actual, expected) {
  assert.deepEqual(actual.journal, expected.journal);
  assert.deepEqual(actual.events, expected.events);
  assert.deepEqual(actual.dual, expected.dual);
  assert.equal(actual.archivePresent, expected.archivePresent);
}

async function fileIdentity(path) {
  const stat = await lstat(path, { bigint: true });
  assert.equal(stat.isFile(), true);
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777n,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  });
}

async function readRegular0600(path, expectedBytes) {
  const stat = await lstat(path);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  const bytes = await readFile(path);
  if (expectedBytes !== undefined) assert.deepEqual(bytes, expectedBytes);
  return bytes;
}

async function archiveSnapshot(root, generationId) {
  const paths = [
    archiveJournalAbs(root, generationId),
    archiveEventsAbs(root, generationId),
    archiveManifestAbs(root, generationId),
  ];
  const entries = [];
  for (const path of paths) {
    entries.push(Object.freeze({
      bytes: await readFile(path),
      identity: await fileIdentity(path),
    }));
  }
  return Object.freeze(entries);
}

function assertArchiveSnapshotEqual(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.deepEqual(actual[i].bytes, expected[i].bytes);
    assert.deepEqual(actual[i].identity, expected[i].identity);
  }
}

async function assertArchiveBundle(root, fixture) {
  const journalBytes = await readRegular0600(
    archiveJournalAbs(root, fixture.generationId),
    fixture.journalBytes,
  );
  const eventsBytes = await readRegular0600(
    archiveEventsAbs(root, fixture.generationId),
    fixture.eventsBytes,
  );
  const manifestBytes = await readRegular0600(
    archiveManifestAbs(root, fixture.generationId),
  );
  assert.equal(manifestBytes.includes(0x0a), false);
  const rawText = manifestBytes.toString('utf8');
  const parsed = parseAuditIntegrityArchiveManifestText(rawText);
  const rebuilt = buildAuditIntegrityArchiveManifest(parsed);
  assert.equal(rebuilt.rawText, rawText);
  assert.equal(rebuilt.digest, sha256(manifestBytes));
  assert.equal(parsed.journal.rawSha256, sha256(journalBytes));
  assert.equal(parsed.events.rawSha256, sha256(eventsBytes));
  return { parsed, manifestBytes };
}

function assertRotationError(error, code, root) {
  assert.equal(error?.name, 'AuditIntegrityRotationError');
  assert.equal(error?.code, code);
  assert.equal(error?.message, code);
  assert.ok(!String(error?.message).includes(root));
  return true;
}

/** Build a persistent stdout line observer before the child can emit READY. */
function observeChild(child) {
  const lines = [];
  const waiters = [];
  let stdoutBuffer = '';
  let stderr = '';

  const dispatch = (line) => {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter.expected !== line) continue;
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes('\n')) {
      const index = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      dispatch(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('child-exited-before-marker'));
      }
      resolve({ code, signal });
    });
  });

  const waitForLine = (expected, timeoutMs) => {
    if (lines.includes(expected)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        expected,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('child-marker-timeout'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return Object.freeze({
    lines,
    exit,
    waitForLine,
    stderr: () => stderr,
  });
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function crashChildAt(root, fixture, crashPoint) {
  assert.ok(Object.hasOwn(CRASH_CASES, crashPoint));
  const child = spawn(
    process.execPath,
    [
      CHILD_SRC,
      'rotate-crash',
      '--data-dir',
      root,
      '--expected-generation-id',
      fixture.generationId,
      '--expected-head-digest',
      fixture.headDigest,
      '--crash-point',
      crashPoint,
    ],
    {
      cwd: REPO_ROOT,
      env: childEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  assert.notEqual(child.pid, process.pid);
  const observed = observeChild(child);

  try {
    await observed.waitForLine('READY', CHILD_READY_MS);
    await writeFile(barrierAbs(root), 'go\n', { flag: 'wx', mode: 0o600 });
    await observed.waitForLine(`CRASH_POINT:${crashPoint}`, CHILD_CRASH_MS);
    assert.equal(child.kill('SIGKILL'), true);
    const exit = await withTimeout(
      observed.exit,
      CHILD_EXIT_MS,
      'child-exit-timeout',
    );
    assert.equal(exit.code, null);
    assert.equal(exit.signal, 'SIGKILL');
    assert.deepEqual(observed.lines, ['READY', `CRASH_POINT:${crashPoint}`]);
    assert.equal(observed.stderr(), '');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runFreshRecovery(root) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [AGENT_SRC, 'audit-integrity-rotation-recover', '--data-dir', root],
      { cwd: REPO_ROOT, env: childEnv(), maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (typeof error.code === 'number') {
      return {
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      };
    }
    throw error;
  }
}

function assertRecoveryReceipt(result, expectedState) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  assert.equal(result.stdout.indexOf('\n'), result.stdout.length - 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, expectedState);
  return receipt;
}

async function assertCompletedWal(root) {
  const wal = parseAuditIntegrityRotationStateText(
    await readFile(rotationStateAbs(root), 'utf8'),
  );
  assert.equal(wal.status, 'completed');
  return wal;
}

async function recoverFreshTwice(root) {
  const first = assertRecoveryReceipt(await runFreshRecovery(root), 'rotated');
  await assertCompletedWal(root);
  const beforeAgain = await snapshotLive(root);
  const second = assertRecoveryReceipt(
    await runFreshRecovery(root),
    'already-completed',
  );
  assertLiveEqual(await snapshotLive(root), beforeAgain);
  assert.equal(second.rotationId, first.rotationId);
  return first;
}

describeReal('V1.43 Task 8 real filesystem and crash acceptance F1-F6', () => {
  it('F1 archive bytes, canonical manifest, regular type, and exact 0600 modes', async () => {
    await withTempRoot('f1', async (root) => {
      const fixture = await createHealthyIdle(root);
      const receipt = await rotateAuditIntegrityGeneration(root, {
        expectedGenerationId: fixture.generationId,
        expectedHeadDigest: fixture.headDigest,
      });
      assert.equal(receipt.state, 'rotated');
      const bundle = await assertArchiveBundle(root, fixture);
      assert.equal(bundle.parsed.previousGenerationId, fixture.generationId);
      assert.equal(receipt.archiveManifestDigest, sha256(bundle.manifestBytes));
      await assertCompletedWal(root);
    });
  });

  it('F2 exact regular EEXIST is idempotent; wrong regular, directory, and symlink conflict', async () => {
    await withTempRoot('f2-exact', async (root) => {
      const fixture = await createHealthyIdle(root);
      await assert.rejects(
        () => rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fixture.generationId,
          expectedHeadDigest: fixture.headDigest,
          [AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-archive-journal',
        }),
        (error) => (error?.code ?? error?.message) === 'TEST_CRASH_AFTER_ARCHIVE_JOURNAL',
      );
      const path = archiveJournalAbs(root, fixture.generationId);
      const beforeBytes = await readRegular0600(path, fixture.journalBytes);
      const beforeIdentity = await fileIdentity(path);
      const receipt = await recoverAuditIntegrityRotation(root);
      assert.equal(receipt.state, 'rotated');
      assert.deepEqual(await readFile(path), beforeBytes);
      assert.deepEqual(await fileIdentity(path), beforeIdentity);
      await assertArchiveBundle(root, fixture);
    });

    for (const kind of ['wrong-regular', 'directory', 'symlink']) {
      await withTempRoot(`f2-${kind}`, async (root) => {
        const fixture = await createHealthyIdle(root);
        const dir = archiveDirAbs(root, fixture.generationId);
        const occupied = archiveJournalAbs(root, fixture.generationId);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        let external = null;
        if (kind === 'wrong-regular') {
          await writeFile(occupied, 'hostile-archive-bytes\n', { mode: 0o600 });
        } else if (kind === 'directory') {
          await mkdir(occupied, { mode: 0o700 });
        } else {
          external = join(root, 'external-symlink-target.bin');
          await writeFile(external, 'external-target-bytes\n', { mode: 0o600 });
          await symlink(external, occupied);
        }

        const liveBefore = await snapshotLive(root);
        const occupiedStatBefore = await lstat(occupied);
        const occupiedBytesBefore = kind === 'wrong-regular'
          ? await readFile(occupied)
          : null;
        const linkBefore = kind === 'symlink' ? await readlink(occupied) : null;
        const externalBefore = external ? await readFile(external) : null;

        await assert.rejects(
          () => rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: fixture.generationId,
            expectedHeadDigest: fixture.headDigest,
          }),
          (error) => assertRotationError(
            error,
            'audit-integrity-rotation-conflict',
            root,
          ),
        );

        const occupiedStatAfter = await lstat(occupied);
        assert.equal(occupiedStatAfter.isFile(), occupiedStatBefore.isFile());
        assert.equal(occupiedStatAfter.isDirectory(), occupiedStatBefore.isDirectory());
        assert.equal(
          occupiedStatAfter.isSymbolicLink(),
          occupiedStatBefore.isSymbolicLink(),
        );
        if (occupiedBytesBefore) {
          assert.deepEqual(await readFile(occupied), occupiedBytesBefore);
        }
        if (linkBefore) assert.equal(await readlink(occupied), linkBefore);
        if (externalBefore) assert.deepEqual(await readFile(external), externalBefore);
        assert.equal(
          await pathExists(archiveEventsAbs(root, fixture.generationId)),
          false,
        );
        assert.equal(
          await pathExists(archiveManifestAbs(root, fixture.generationId)),
          false,
        );
        const liveAfter = await snapshotLive(root);
        assertLiveDataEqual(liveAfter, liveBefore);
        const wal = parseAuditIntegrityRotationStateText(
          await readFile(rotationStateAbs(root), 'utf8'),
        );
        assert.equal(wal.status, 'prepared');
      });
    }
  });

  it('F3 SIGKILL after CP3 manifest commit recovers forward in a fresh process', async () => {
    await withTempRoot('f3', async (root) => {
      const fixture = await createHealthyIdle(root);
      await crashChildAt(root, fixture, 'CP3');
      const wal = parseAuditIntegrityRotationStateText(
        await readFile(rotationStateAbs(root), 'utf8'),
      );
      assert.equal(wal.status, CRASH_CASES.CP3.status);
      await assertArchiveBundle(root, fixture);
      assert.deepEqual(await readFile(journalAbs(root)), fixture.journalBytes);
      assert.deepEqual(await readFile(eventsAbs(root)), fixture.eventsBytes);
      assert.deepEqual(await readFile(dualStateAbs(root)), fixture.dualBytes);
      const receipt = await recoverFreshTwice(root);
      assert.equal(receipt.previousGenerationId, fixture.generationId);
      await assertArchiveBundle(root, fixture);
    });
  });

  it('F4 SIGKILL after CP4 preserves the new journal and publishes remaining stores', async () => {
    await withTempRoot('f4', async (root) => {
      const fixture = await createHealthyIdle(root);
      await crashChildAt(root, fixture, 'CP4');
      const wal = parseAuditIntegrityRotationStateText(
        await readFile(rotationStateAbs(root), 'utf8'),
      );
      assert.equal(wal.status, CRASH_CASES.CP4.status);
      const journalBefore = await readFile(journalAbs(root));
      const journalIdentityBefore = await fileIdentity(journalAbs(root));
      assert.notDeepEqual(journalBefore, fixture.journalBytes);
      assert.deepEqual(await readFile(eventsAbs(root)), fixture.eventsBytes);
      assert.deepEqual(await readFile(dualStateAbs(root)), fixture.dualBytes);

      await recoverFreshTwice(root);
      assert.deepEqual(await readFile(journalAbs(root)), journalBefore);
      assert.deepEqual(await fileIdentity(journalAbs(root)), journalIdentityBefore);
      assert.notDeepEqual(await readFile(eventsAbs(root)), fixture.eventsBytes);
      assert.notDeepEqual(await readFile(dualStateAbs(root)), fixture.dualBytes);
      await assertArchiveBundle(root, fixture);
    });
  });

  it('F5 CP5 and CP6 SIGKILL subcases converge and second fresh recovery is idempotent', async () => {
    for (const crashPoint of ['CP5', 'CP6']) {
      await withTempRoot(`f5-${crashPoint}`, async (root) => {
        const fixture = await createHealthyIdle(root);
        await crashChildAt(root, fixture, crashPoint);
        const wal = parseAuditIntegrityRotationStateText(
          await readFile(rotationStateAbs(root), 'utf8'),
        );
        assert.equal(wal.status, CRASH_CASES[crashPoint].status);

        const journalBefore = await readFile(journalAbs(root));
        const eventsBefore = await readFile(eventsAbs(root));
        const dualBefore = await readFile(dualStateAbs(root));
        const journalIdentityBefore = await fileIdentity(journalAbs(root));
        const eventsIdentityBefore = await fileIdentity(eventsAbs(root));
        const dualIdentityBefore = await fileIdentity(dualStateAbs(root));
        assert.notDeepEqual(journalBefore, fixture.journalBytes);
        assert.notDeepEqual(eventsBefore, fixture.eventsBytes);
        if (crashPoint === 'CP5') {
          assert.deepEqual(dualBefore, fixture.dualBytes);
        } else {
          assert.notDeepEqual(dualBefore, fixture.dualBytes);
        }

        await recoverFreshTwice(root);
        assert.deepEqual(await readFile(journalAbs(root)), journalBefore);
        assert.deepEqual(await readFile(eventsAbs(root)), eventsBefore);
        assert.deepEqual(await fileIdentity(journalAbs(root)), journalIdentityBefore);
        assert.deepEqual(await fileIdentity(eventsAbs(root)), eventsIdentityBefore);
        if (crashPoint === 'CP6') {
          assert.deepEqual(await readFile(dualStateAbs(root)), dualBefore);
          assert.deepEqual(await fileIdentity(dualStateAbs(root)), dualIdentityBefore);
        } else {
          assert.notDeepEqual(await readFile(dualStateAbs(root)), dualBefore);
        }
        await assertArchiveBundle(root, fixture);
      });
    }
  });

  it('F6 append after recovery is healthy and leaves archive bytes and inode facts unchanged', async () => {
    await withTempRoot('f6', async (root) => {
      const fixture = await createHealthyIdle(root);
      await crashChildAt(root, fixture, 'CP3');
      await recoverFreshTwice(root);
      const archiveBefore = await archiveSnapshot(root, fixture.generationId);

      await appendAuditEventWithIntegrityDualWrite(root, {
        ...EVENT_AFTER_RECOVERY,
      });
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.ok(new Set([
        'equal',
        'events-suffix-of-journal',
        'journal-suffix-of-events',
      ]).has(cross.relationship));
      const monitor = await runAuditIntegrityMonitor(root);
      assert.equal(monitor.status, 'healthy');
      assert.equal(monitor.recoveryRequired, false);
      assert.equal(monitor.alertRequired, false);

      const archiveAfter = await archiveSnapshot(root, fixture.generationId);
      assertArchiveSnapshotEqual(archiveAfter, archiveBefore);
      await assertCompletedWal(root);
    });
  });
});
