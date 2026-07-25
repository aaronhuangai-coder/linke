/**
 * Linke V1.43 Task 7 — explicit local Agent CLI rotation contracts L1-L5.
 *
 * Every behavior path executes the real `node src/agent.js` subprocess.
 * Fixtures and preload probes live under mkdtemp(tmpdir()) only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendAuditEventWithIntegrityDualWrite,
  recoverAuditIntegrityDualWrite,
} from '../src/audit-integrity-dual-write.js';
import { parseAuditIntegrityDualWriteStateText } from '../src/audit-integrity-dual-write-state.js';
import {
  AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK,
  rotateAuditIntegrityGeneration,
} from '../src/audit-integrity-rotation.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const SERVER_SRC = join(REPO_ROOT, 'src', 'server.js');
const WEB_APP_SRC = join(REPO_ROOT, 'src', 'web', 'app.js');

const ROTATE_COMMAND = 'audit-integrity-rotate';
const RECOVER_COMMAND = 'audit-integrity-rotation-recover';
const INVALID_ROTATE = 'Error: audit-integrity-rotate arguments are invalid\n';
const REFUSED_ROTATE = 'Error: audit-integrity-rotate refused\n';
const FAILED_ROTATE = 'Error: audit-integrity-rotate failed\n';
const INVALID_RECOVER =
  'Error: audit-integrity-rotation-recover arguments are invalid\n';
const REFUSED_RECOVER = 'Error: audit-integrity-rotation-recover refused\n';
const FAILED_RECOVER = 'Error: audit-integrity-rotation-recover failed\n';
const CRASH_AFTER_PREPARED = 'TEST_CRASH_AFTER_PREPARED';

const RECEIPT_KEYS = Object.freeze([
  'state',
  'rotationId',
  'previousGenerationId',
  'generationId',
  'archiveRelativePath',
  'archiveManifestDigest',
  'previousRecordCount',
  'newRecordCount',
  'relationship',
]);

const EVENT = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
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

function archiveManifestAbs(root, generationId) {
  return join(root, 'audit', 'archive', generationId, 'manifest.json');
}

function lockAbs(root) {
  return join(root, 'audit', 'integrity-write.lock');
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

async function runAgent(argv, { env = {} } = {}) {
  try {
    const result = await execFileAsync('node', [AGENT_SRC, ...argv], {
      env: cleanEnv(env),
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      code: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
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

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-agent-rotation-${prefix}-`));
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

async function createHealthyIdle(root) {
  await recoverAuditIntegrityDualWrite(root);
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT });
  const idle = parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  assert.equal(idle.status, 'idle');
  assert.match(idle.generationId, /^[0-9a-f]{32}$/);
  assert.match(idle.journal.headDigest, /^[0-9a-f]{64}$/);
  return {
    generationId: idle.generationId,
    headDigest: idle.journal.headDigest,
  };
}

function rotateArgv(root, generationId, headDigest) {
  return [
    ROTATE_COMMAND,
    '--data-dir',
    root,
    '--expected-generation-id',
    generationId,
    '--expected-head-digest',
    headDigest,
  ];
}

function assertNoLeak(text, needles = []) {
  const value = String(text);
  assert.ok(!value.includes('/private/'));
  assert.ok(!value.includes('/var/folders/'));
  assert.ok(!value.includes('/Users/'));
  assert.ok(!value.includes('ENOENT'));
  assert.ok(!value.includes('EACCES'));
  assert.ok(!value.includes('errno'));
  assert.ok(!value.includes('Bearer'));
  assert.ok(!value.includes(' at file:'));
  for (const needle of needles) {
    if (needle) assert.ok(!value.includes(needle), `must not leak ${needle}`);
  }
}

function assertSingleLineReceipt(stdout, root) {
  assert.ok(stdout.endsWith('\n'));
  assert.equal(stdout.indexOf('\n'), stdout.length - 1);
  const body = stdout.slice(0, -1);
  const receipt = JSON.parse(body);
  assert.equal(JSON.stringify(receipt), body);
  assert.deepEqual(Object.keys(receipt), [...RECEIPT_KEYS]);
  assert.ok(!body.includes(root));
  assert.ok(!receipt.archiveRelativePath.startsWith('/'));
  assertNoLeak(body, [root]);
  return receipt;
}

function assertInvalid(result, stderr, needles = []) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stderr);
  assertNoLeak(result.stderr, needles);
}

function assertRefused(result, stderr, root) {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stderr);
  assertNoLeak(result.stderr, [root]);
}

async function prepareWal(root) {
  const fixture = await createHealthyIdle(root);
  await assert.rejects(
    () => rotateAuditIntegrityGeneration(root, {
      expectedGenerationId: fixture.generationId,
      expectedHeadDigest: fixture.headDigest,
      [AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-prepared',
    }),
    (error) => {
      assert.equal(error.code ?? error.message, CRASH_AFTER_PREPARED);
      return true;
    },
  );
  const wal = JSON.parse(await readFile(rotationStateAbs(root), 'utf8'));
  assert.equal(wal.status, 'prepared');
  return { fixture, wal };
}

async function writeStdoutFailurePreload(root) {
  const preload = join(root, 'stdout-failure-preload.mjs');
  await writeFile(
    preload,
    [
      "const target = process.env.LINKE_TEST_AGENT_SRC;",
      "const command = process.env.LINKE_TEST_FAIL_COMMAND;",
      "if (process.argv[1] === target && process.argv[2] === command) {",
      "  Object.defineProperty(process.stdout, 'write', {",
      "    configurable: true,",
      "    value() { throw new Error('UNCLASSIFIED_SENTINEL'); },",
      "  });",
      "}",
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return preload;
}

describe('V1.43 Task 7 explicit Agent CLI rotation L1-L5', () => {
  it('L1 rotate success emits one compact path-free receipt and completed v2 facts', async () => {
    await withTempRoot('l1', async (root) => {
      const fixture = await createHealthyIdle(root);
      const result = await runAgent(
        rotateArgv(root, fixture.generationId, fixture.headDigest),
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const receipt = assertSingleLineReceipt(result.stdout, root);
      assert.equal(receipt.state, 'rotated');
      assert.equal(receipt.previousGenerationId, fixture.generationId);

      const wal = JSON.parse(await readFile(rotationStateAbs(root), 'utf8'));
      assert.equal(wal.status, 'completed');
      assert.equal(wal.rotationId, receipt.rotationId);
      assert.equal(wal.nextGenerationId, receipt.generationId);
      const idle = parseAuditIntegrityDualWriteStateText(
        await readFile(dualStateAbs(root), 'utf8'),
      );
      assert.equal(idle.schemaVersion, 1);
      assert.equal(idle.status, 'idle');
      assert.equal(idle.generationId, receipt.generationId);
      assert.equal(
        await pathExists(archiveManifestAbs(root, fixture.generationId)),
        true,
      );
    });
  });

  it('L2 recover success rolls a real prepared WAL forward and emits one receipt', async () => {
    await withTempRoot('l2', async (root) => {
      const { fixture } = await prepareWal(root);
      const result = await runAgent([
        RECOVER_COMMAND,
        '--data-dir',
        root,
      ]);

      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const receipt = assertSingleLineReceipt(result.stdout, root);
      assert.equal(receipt.state, 'rotated');
      assert.equal(receipt.previousGenerationId, fixture.generationId);
      const wal = JSON.parse(await readFile(rotationStateAbs(root), 'utf8'));
      assert.equal(wal.status, 'completed');
      assert.equal(wal.rotationId, receipt.rotationId);
      assert.equal(
        await pathExists(archiveManifestAbs(root, fixture.generationId)),
        true,
      );
    });
  });

  it('L3 strict argv rejects duplicates missing values extras token symbols and invalid hex', async () => {
    const goodId = 'a'.repeat(32);
    const goodDigest = 'b'.repeat(64);
    const secretPath = '/tmp/LINKE_L3_SECRET_PATH';
    const secretToken = 'LINKE_L3_SECRET_TOKEN';
    const rotateCases = [
      [ROTATE_COMMAND],
      [ROTATE_COMMAND, '--data-dir'],
      rotateArgv('   ', goodId, goodDigest),
      [ROTATE_COMMAND, '--data-dir', secretPath, '--data-dir', secretPath,
        '--expected-generation-id', goodId, '--expected-head-digest', goodDigest],
      [...rotateArgv(secretPath, goodId, goodDigest),
        '--expected-generation-id', goodId],
      [...rotateArgv(secretPath, goodId, goodDigest),
        '--expected-head-digest', goodDigest],
      [...rotateArgv(secretPath, goodId, goodDigest), '--extra'],
      [...rotateArgv(secretPath, goodId, goodDigest), 'extra-positional'],
      [ROTATE_COMMAND, '--expected-generation-id', goodId, '--data-dir', secretPath,
        '--expected-head-digest', goodDigest],
      [...rotateArgv(secretPath, goodId, goodDigest), '--token', secretToken],
      [...rotateArgv(secretPath, goodId, goodDigest), '--token'],
      [ROTATE_COMMAND, '--help'],
      [ROTATE_COMMAND, '--h'],
      [ROTATE_COMMAND, '--__proto__', secretToken],
      rotateArgv('--flag-like-path', goodId, goodDigest),
      rotateArgv(secretPath, goodId.toUpperCase(), goodDigest),
      rotateArgv(secretPath, `${goodId.slice(0, 31)}!`, goodDigest),
      rotateArgv(secretPath, goodId.slice(1), goodDigest),
      rotateArgv(secretPath, `${goodId}0`, goodDigest),
      rotateArgv(secretPath, goodId, goodDigest.toUpperCase()),
      rotateArgv(secretPath, goodId, `${goodDigest.slice(0, 63)}!`),
      rotateArgv(secretPath, goodId, goodDigest.slice(1)),
      rotateArgv(secretPath, goodId, `${goodDigest}0`),
    ];
    const recoverCases = [
      [RECOVER_COMMAND],
      [RECOVER_COMMAND, '--data-dir'],
      [RECOVER_COMMAND, '--data-dir', '   '],
      [RECOVER_COMMAND, '--data-dir', secretPath, '--data-dir', secretPath],
      [RECOVER_COMMAND, '--data-dir', secretPath, '--extra'],
      [RECOVER_COMMAND, '--data-dir', secretPath, 'extra-positional'],
      [RECOVER_COMMAND, secretPath, '--data-dir'],
      [RECOVER_COMMAND, '--data-dir', secretPath, '--token', secretToken],
      [RECOVER_COMMAND, '--data-dir', secretPath, '--token'],
      [RECOVER_COMMAND, '--help'],
      [RECOVER_COMMAND, '--h'],
      [RECOVER_COMMAND, '--__proto__', secretToken],
      [RECOVER_COMMAND, '--data-dir', '--flag-like-path'],
    ];

    for (const argv of rotateCases) {
      assertInvalid(
        await runAgent(argv),
        INVALID_ROTATE,
        [secretPath, secretToken],
      );
    }
    for (const argv of recoverCases) {
      assertInvalid(
        await runAgent(argv),
        INVALID_RECOVER,
        [secretPath, secretToken],
      );
    }
  });

  it('L4 registered rotation and process-lock refusals exit 2 without unsafe advancement', async () => {
    await withTempRoot('l4-stale', async (root) => {
      const fixture = await createHealthyIdle(root);
      const before = await snapshotLive(root);
      const result = await runAgent(
        rotateArgv(root, 'f'.repeat(32), fixture.headDigest),
      );
      assertRefused(result, REFUSED_ROTATE, root);
      assertLiveEqual(await snapshotLive(root), before);
    });

    await withTempRoot('l4-lock', async (root) => {
      const fixture = await createHealthyIdle(root);
      await rm(lockAbs(root));
      await mkdir(lockAbs(root), { mode: 0o700 });
      const before = await snapshotLive(root);
      const result = await runAgent(
        rotateArgv(root, fixture.generationId, fixture.headDigest),
      );
      assertRefused(result, REFUSED_ROTATE, root);
      assertLiveEqual(await snapshotLive(root), before);
      assert.equal((await lstat(lockAbs(root))).isDirectory(), true);
    });

    await withTempRoot('l4-recover', async (root) => {
      const result = await runAgent([RECOVER_COMMAND, '--data-dir', root]);
      assertRefused(result, REFUSED_RECOVER, root);
      assert.equal(await pathExists(rotationStateAbs(root)), false);
      assert.equal(await pathExists(archiveRootAbs(root)), false);
    });
  });

  it('L5 unclassified program failures exit 1 and commands remain Agent-only', async () => {
    await withTempRoot('l5-rotate', async (root) => {
      const fixture = await createHealthyIdle(root);
      const preload = await writeStdoutFailurePreload(root);
      const result = await runAgent(
        rotateArgv(root, fixture.generationId, fixture.headDigest),
        {
          env: {
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            LINKE_TEST_AGENT_SRC: AGENT_SRC,
            LINKE_TEST_FAIL_COMMAND: ROTATE_COMMAND,
          },
        },
      );
      assertInvalid(result, FAILED_ROTATE, [root, 'UNCLASSIFIED_SENTINEL']);
    });

    await withTempRoot('l5-recover', async (root) => {
      await prepareWal(root);
      const preload = await writeStdoutFailurePreload(root);
      const result = await runAgent(
        [RECOVER_COMMAND, '--data-dir', root],
        {
          env: {
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            LINKE_TEST_AGENT_SRC: AGENT_SRC,
            LINKE_TEST_FAIL_COMMAND: RECOVER_COMMAND,
          },
        },
      );
      assertInvalid(result, FAILED_RECOVER, [root, 'UNCLASSIFIED_SENTINEL']);
    });

    const [agentSource, serverSource, webSource] = await Promise.all([
      readFile(AGENT_SRC, 'utf8'),
      readFile(SERVER_SRC, 'utf8'),
      readFile(WEB_APP_SRC, 'utf8'),
    ]);
    assert.ok(agentSource.includes(ROTATE_COMMAND));
    assert.ok(agentSource.includes(RECOVER_COMMAND));
    assert.ok(!serverSource.includes(ROTATE_COMMAND));
    assert.ok(!serverSource.includes(RECOVER_COMMAND));
    assert.ok(!webSource.includes(ROTATE_COMMAND));
    assert.ok(!webSource.includes(RECOVER_COMMAND));
  });
});
