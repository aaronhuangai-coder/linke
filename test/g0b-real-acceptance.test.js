/**
 * V1.41 C8 — G0b Real-LAN Harness + Honesty (Hardware-Gated)
 * Auto production-boundary harness (child_process endpoint) + exact real-LAN gate.
 * Same-process mock must not claim real-LAN evidence. Report absent without hardware PASS.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import { buildGoldReadinessReport } from '../src/gold-readiness.js';
import {
  REAL_GATE_ENV,
  REAL_GATE_VALUE,
  AUTO_GATE_ENV,
  AUTO_GATE_VALUE,
  AUTO_SCENARIOS,
  REAL_REPORT_RELATIVE_PATH,
  PURPOSE,
  SCHEMA_VERSION,
  RUN_MARKER_FILE,
  assertRealGate,
  assertAutoGate,
  assertAutoScenario,
  assertDedicatedRunDirectory,
  atomicWritePrivateJson,
  readPrivateJson,
  serializeSanitizedResult,
  sanitizedFailure,
  assertNoSensitiveData,
  validateControllerConfig,
  validateAutoEndpointBundle,
} from './helpers/g0b-real-common.js';
import {
  createAutoControllerHarness,
  createRealControllerHarness,
  runControllerHarnessMain,
} from './helpers/g0b-real-controller-runner.js';
import {
  createAutoEndpointHarness,
  createRealEndpointHarness,
  runEndpointHarnessMain,
} from './helpers/g0b-real-endpoint-runner.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTROLLER_RUNNER = join(REPO_ROOT, 'test/helpers/g0b-real-controller-runner.js');
const ENDPOINT_RUNNER = join(REPO_ROOT, 'test/helpers/g0b-real-endpoint-runner.js');
const REPORT_ABS = join(REPO_ROOT, REAL_REPORT_RELATIVE_PATH);
const README_PATH = join(REPO_ROOT, 'README.md');

const V141_SIGNATURE =
  'V1.41 G0b resumable manifest v2 snapshot upload implementation';
const V140_SIGNATURE =
  'V1.40 local multi-process audit integrity write exclusive lock implementation';

async function privateDir() {
  const root = await mkdtemp(join(tmpdir(), 'linke-g0b-common-'));
  await chmod(root, 0o700);
  return root;
}

async function dedicatedRunDir() {
  const root = await privateDir();
  await atomicWritePrivateJson(join(root, RUN_MARKER_FILE), {
    schemaVersion: SCHEMA_VERSION,
    purpose: PURPOSE,
  });
  return root;
}

function runNodeChild(args, env = {}, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        // Explicit override: allow tests to clear gates even if parent has them.
        [REAL_GATE_ENV]: Object.prototype.hasOwnProperty.call(env, REAL_GATE_ENV)
          ? env[REAL_GATE_ENV]
          : '',
        [AUTO_GATE_ENV]: Object.prototype.hasOwnProperty.call(env, AUTO_GATE_ENV)
          ? env[AUTO_GATE_ENV]
          : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr, pid: child.pid }));
  });
}

describe('G0b real common gate and sanitization', () => {
  it('requires exact real-LAN and auto gates (case-sensitive enabled)', () => {
    assert.throws(() => assertRealGate({}), (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
    assert.throws(() => assertRealGate({ [REAL_GATE_ENV]: 'ENABLED' }));
    assert.throws(() => assertRealGate({ [REAL_GATE_ENV]: '1' }));
    assert.equal(assertRealGate({ [REAL_GATE_ENV]: REAL_GATE_VALUE }), true);

    assert.throws(() => assertAutoGate({}));
    assert.throws(() => assertAutoGate({ [AUTO_GATE_ENV]: 'ENABLED' }));
    assert.equal(assertAutoGate({ [AUTO_GATE_ENV]: AUTO_GATE_VALUE }), true);
  });

  it('locks the four auto scenarios exactly', () => {
    assert.deepEqual([...AUTO_SCENARIOS], [
      'disconnect-resume',
      'corrupt-chunk',
      'manifest-conflict',
      'cross-device-deny',
    ]);
    for (const s of AUTO_SCENARIOS) {
      assert.equal(assertAutoScenario(s), s);
    }
    assert.throws(() => assertAutoScenario('same-process-mock'));
    assert.throws(() => assertAutoScenario(''));
  });

  it('serializes only allowlisted sanitized fields and rejects secrets', () => {
    const safe = serializeSanitizedResult({
      role: 'endpoint',
      phase: 'disconnect-resume',
      status: 'PASS',
      code: ERROR_CODES.UPLOAD_INTEGRITY_FAILED,
      at: '2030-01-01T00:00:00.000Z',
    });
    assert.doesNotThrow(() => JSON.parse(safe));
    for (const value of [
      '/private/synthetic/path',
      'https://192.0.2.10:3443',
      'a'.repeat(64),
      '-----BEGIN PRIVATE KEY-----',
      'synthetic-token-value',
    ]) {
      assert.throws(() => assertNoSensitiveData({ nested: { note: value } }));
    }
    const failure = sanitizedFailure(
      'controller',
      'main',
      new Error('raw path /Users/secret'),
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    assert.deepEqual(failure, {
      role: 'controller',
      phase: 'main',
      status: 'FAIL',
      code: ERROR_CODES.DEVICE_INTERNAL_ERROR,
      at: '2030-01-01T00:00:00.000Z',
    });
    assert.doesNotMatch(JSON.stringify(failure), /Users|secret|token|fingerprint/i);
  });

  it('accepts only private-IP real controller config and loopback auto bundles', () => {
    assert.deepEqual(validateControllerConfig({
      schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0,
    }), {
      schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0,
    });
    assert.throws(() => validateControllerConfig({
      schemaVersion: 1, agentHost: '127.0.0.1', agentPort: 3443, managementPort: 0,
    }));

    const auto = validateAutoEndpointBundle({
      schemaVersion: 1,
      purpose: PURPOSE,
      kind: 'auto-endpoint',
      agentUrl: 'https://127.0.0.1:3443',
      tlsFingerprint: 'a'.repeat(64),
      deviceA: { deviceId: 'device-a', token: 't'.repeat(32) },
      deviceB: { deviceId: 'device-b', token: 'u'.repeat(32) },
      snapshotRootRelative: 'snap',
    });
    assert.equal(auto.kind, 'auto-endpoint');
    assert.throws(() => validateAutoEndpointBundle({
      ...auto,
      agentUrl: 'https://10.0.0.10:3443',
    }));
  });

  it('writes atomic 0600 private JSON', async () => {
    const root = await privateDir();
    const target = join(root, 'bundle.json');
    await atomicWritePrivateJson(target, { schemaVersion: 1, runId: 'run-synthetic' });
    const { lstat } = await import('node:fs/promises');
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(target, (v) => v), {
      schemaVersion: 1,
      runId: 'run-synthetic',
    });
  });
});

describe('G0b import zero side effects and direct main fail-closed', () => {
  it('module import emits zero stdout/stderr and installs no listeners', async () => {
    const importProbe = await runNodeChild(['-e',
      "import('./test/helpers/g0b-real-controller-runner.js');"
      + "import('./test/helpers/g0b-real-endpoint-runner.js');"
      + "import('./test/helpers/g0b-real-common.js');"
      + "console.error('PROBE_OK');"], {});
    assert.equal(importProbe.stdout.trim(), '');
    assert.match(importProbe.stderr, /PROBE_OK/);
    assert.doesNotMatch(importProbe.stderr, /token|fingerprint|BEGIN |\/Users/i);
  });

  it('direct controller main without gate emits one sanitized FAIL line', async () => {
    const child = await runNodeChild([CONTROLLER_RUNNER], {
      [REAL_GATE_ENV]: '',
      [AUTO_GATE_ENV]: '',
    });
    const lines = child.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.role, 'controller');
    assert.equal(line.status, 'FAIL');
    assert.equal(line.phase, 'main');
    // Full-IP validation (assertNoSensitiveData) avoids matching ISO timestamps at second 10.
    assert.doesNotThrow(() => assertNoSensitiveData(line));
    assert.doesNotMatch(child.stdout, /token|fingerprint|private|\/Users|BEGIN /i);
    assert.doesNotMatch(child.stderr, /token|fingerprint|enrollment|BEGIN /i);
  });

  it('direct endpoint main without gate emits one sanitized FAIL line', async () => {
    const child = await runNodeChild([ENDPOINT_RUNNER, 'auto', 'disconnect-resume'], {
      [REAL_GATE_ENV]: '',
      [AUTO_GATE_ENV]: '',
    });
    const lines = child.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.role, 'endpoint');
    assert.equal(line.status, 'FAIL');
    assert.doesNotMatch(child.stdout, /token|fingerprint|https?:\/\/|\/Users/i);
  });

  it('direct endpoint main rejects extra argv even with auto gate', async () => {
    const child = await runNodeChild(
      [ENDPOINT_RUNNER, 'auto', 'disconnect-resume', 'extra'],
      {
        [AUTO_GATE_ENV]: AUTO_GATE_VALUE,
        [REAL_GATE_ENV]: '',
      },
    );
    const lines = child.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.role, 'endpoint');
    assert.equal(line.status, 'FAIL');
    assert.doesNotMatch(child.stdout, /token|fingerprint|BEGIN |https?:\/\//i);
  });

  it('real controller harness without dedicated runDir fails closed when gate on', async () => {
    await assert.rejects(
      createRealControllerHarness({
        env: { [REAL_GATE_ENV]: REAL_GATE_VALUE },
        runDir: await privateDir(), // no marker
      }),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );
  });
});

describe('G0b auto production boundary via independent child_process endpoint', () => {
  it('runs all four scenarios with production stack + child endpoint (not same-process mock evidence)', async () => {
    /** @type {string[]} */
    const childPids = [];
    /** @type {string[]} */
    const statuses = [];

    for (const scenario of AUTO_SCENARIOS) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-g0b-data-'));
      await chmod(dataDir, 0o700);
      const runDir = await dedicatedRunDir();
      const controller = await createAutoControllerHarness({ dataDir });
      try {
        await controller.writeAutoBundle(runDir, { snapshotRootRelative: 'snapshot-root' });
        const child = await runNodeChild(
          [ENDPOINT_RUNNER, 'auto', scenario],
          {
            [AUTO_GATE_ENV]: AUTO_GATE_VALUE,
            [REAL_GATE_ENV]: '',
          },
          { cwd: runDir },
        );
        childPids.push(String(child.pid));
        const lines = child.stdout.trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 1, scenario);
        const result = JSON.parse(lines[0]);
        assert.equal(result.role, 'endpoint', scenario);
        assert.equal(result.phase, scenario, scenario);
        assert.equal(result.status, 'PASS', `${scenario}: ${child.stdout} ${child.stderr}`);
        statuses.push(result.status);

        // Sanitized: no host/IP/URL/path/fingerprint/token/secret
        assert.doesNotMatch(child.stdout, /https?:\/\/|127\.0\.0\.1|token|fingerprint|BEGIN |\/Users|\/var\/|private/i);
        assert.doesNotMatch(child.stderr, /token|fingerprint|BEGIN PRIVATE|enrollment/i);

        if (scenario === 'corrupt-chunk') {
          assert.ok(
            result.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED
              || result.code === ERROR_CODES.UPLOAD_CHUNK_INVALID,
            scenario,
          );
          assert.equal(result.flag, true);
        }
        if (scenario === 'manifest-conflict') {
          assert.equal(result.code, ERROR_CODES.UPLOAD_SESSION_CONFLICT);
          assert.equal(result.flag, true);
        }
        if (scenario === 'cross-device-deny') {
          assert.equal(result.code, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
          assert.equal(result.flag, true);
        }
      } finally {
        await controller.close();
      }
    }

    assert.equal(statuses.length, 4);
    assert.ok(statuses.every((s) => s === 'PASS'));
    // Independent child processes (distinct pids when sequential still proves child_process path)
    assert.equal(childPids.length, 4);
    assert.ok(childPids.every((p) => /^\d+$/.test(p)));
  });

  it('programmatic auto endpoint uses production client path for disconnect-resume finalize', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-g0b-data-'));
    await chmod(dataDir, 0o700);
    const runDir = await dedicatedRunDir();
    const controller = await createAutoControllerHarness({ dataDir });
    try {
      await controller.writeAutoBundle(runDir);
      const harness = await createAutoEndpointHarness({ runDir });
      const result = await harness.runScenario('disconnect-resume');
      assert.equal(result.status, 'PASS');
      assert.equal(result.phase, 'disconnect-resume');
      assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|token|fingerprint|\/Users/i);
    } finally {
      await controller.close();
    }
  });
});

describe('G0b real-LAN hardware gate default skip + report absent', () => {
  it('real-LAN evidence report must not exist (no hardware PASS)', async () => {
    await assert.rejects(
      access(REPORT_ABS),
      (e) => e && e.code === 'ENOENT',
    );
  });

  it('real endpoint with gate + dedicated dir returns BLOCKED (no silent PASS)', async () => {
    const runDir = await dedicatedRunDir();
    const harness = await createRealEndpointHarness({
      env: { [REAL_GATE_ENV]: REAL_GATE_VALUE },
      runDir,
    });
    const result = await harness.runPhase('upload-full');
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.role, 'endpoint');
    // Full-IP validation (assertNoSensitiveData) avoids matching ISO timestamps at second 10.
    assert.doesNotThrow(() => assertNoSensitiveData(result));
    assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|token|fingerprint|\/Users/i);
  });

  it('default CI (gate off) does not open real harness side effects', async () => {
    await assert.rejects(
      createRealEndpointHarness({ env: {}, runDir: await dedicatedRunDir() }),
      (e) => e instanceof LinkeError,
    );
    await assert.rejects(
      createRealControllerHarness({ env: {}, runDir: await dedicatedRunDir() }),
      (e) => e instanceof LinkeError,
    );
  });
});

const V142_SIGNATURE =
  'V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation';

describe('G0b V1.42 current surface + V1.41 historical honesty (G0b real-LAN remains absent)', () => {
  it('LINKE_RELEASE_VERSION is exactly V1.42 (signature not embedded; G0b signature historical)', () => {
    assert.equal(LINKE_RELEASE_VERSION, 'V1.42');
    assert.notEqual(LINKE_RELEASE_VERSION, V142_SIGNATURE);
    assert.notEqual(LINKE_RELEASE_VERSION, V141_SIGNATURE);
    assert.ok(!LINKE_RELEASE_VERSION.includes('G0c'));
    assert.ok(!LINKE_RELEASE_VERSION.includes('G0b'));
    // Historical G0b signature constant must remain exact.
    assert.equal(
      V141_SIGNATURE,
      'V1.41 G0b resumable manifest v2 snapshot upload implementation',
    );
  });

  it('Gold remains blocked 4/4/1/9; statuses frozen; V1.42 current + V1.41 G0b historical', () => {
    const report = buildGoldReadinessReport({ now: new Date('2026-07-22T12:00:00.000Z') });
    assert.equal(report.version, 'V1.42');
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.summary, { ready: 4, partial: 4, blocked: 1, total: 9 });

    const snapshot = report.items.map((item) => ({ id: item.id, status: item.status }));
    assert.deepEqual(snapshot, [
      { id: 'release-readiness', status: 'ready' },
      { id: 'local-backup-restore', status: 'ready' },
      { id: 'fleet-device-management', status: 'ready' },
      { id: 'version-consistency', status: 'ready' },
      { id: 'nas-dry-run', status: 'partial' },
      { id: 'automation-installation', status: 'partial' },
      { id: 'security-auth', status: 'partial' },
      { id: 'real-nas-remote-backup', status: 'blocked' },
      { id: 'production-hardening', status: 'partial' },
    ]);

    const hardening = report.items.find((i) => i.id === 'production-hardening');
    assert.ok(hardening);
    const evidenceText = hardening.evidence.join('\n');
    assert.ok(evidenceText.includes(V142_SIGNATURE));
    assert.ok(evidenceText.includes(V141_SIGNATURE), 'retain V1.41 G0b historical baseline');
    assert.ok(evidenceText.includes(V140_SIGNATURE), 'retain V1.40 historical baseline');
    assert.ok(
      evidenceText.includes('auto harness complete ≠ real-LAN complete')
        || /auto harness complete is not real-LAN complete|auto complete ≠ real-LAN complete|auto complete is not real-LAN complete/i.test(evidenceText)
        || evidenceText.includes('auto harness complete is not real-LAN complete'),
    );
    // G0b real-LAN remains absent (historical boundary — must not claim G0b real-LAN complete)
    assert.ok(
      evidenceText.includes('G0b real-LAN evidence absent')
        || evidenceText.includes('real-LAN evidence absent'),
    );
    assert.ok(
      evidenceText.includes('not G0b real-LAN complete')
        || /not.*G0b real-LAN complete/i.test(evidenceText)
        || evidenceText.includes('G0b real-LAN evidence absent')
        || evidenceText.includes('G0c real-LAN evidence absent'),
    );
    assert.ok(evidenceText.includes('not Gold') || evidenceText.includes('Gold remains blocked'));
    assert.ok(evidenceText.includes('Gold remains blocked 4/4/1/9'));

    assert.ok(hardening.nextStep.startsWith('V1.42'));
    assert.ok(hardening.nextStep.includes(V142_SIGNATURE));
    assert.ok(hardening.nextStep.includes(V141_SIGNATURE));
    assert.ok(hardening.nextStep.includes(V140_SIGNATURE)
      || /V1\.40 historical/.test(hardening.nextStep));
    assert.ok(/real-LAN evidence absent|G0b real-LAN evidence absent|G0c real-LAN evidence absent/i.test(hardening.nextStep));
    assert.ok(/Gold remains blocked 4\/4\/1\/9/.test(hardening.nextStep));
  });

  it('README current surface is V1.42/G0c; V1.41 historical; G0b real-LAN absent retained', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const firstLine = readme.split('\n')[0].trim();
    assert.equal(firstLine, '# Linke V1.42');
    assert.ok(readme.includes('**当前版本：V1.42**'));

    const lines = readme.split('\n');
    const currentRow = lines.find((l) => l.includes('| V1.42 |') && l.includes('当前版本'));
    assert.ok(currentRow, 'V1.42 current version table row');
    assert.ok(currentRow.includes(V142_SIGNATURE));
    assert.ok(
      currentRow.includes('auto harness complete is not real-LAN complete')
        || /auto.*not.*real-LAN complete/i.test(currentRow)
        || currentRow.includes('auto harness complete ≠ real-LAN complete'),
    );
    assert.ok(
      currentRow.includes('G0c real-LAN evidence absent')
        || /real-LAN evidence absent/i.test(currentRow),
    );
    assert.ok(currentRow.includes('Gold remains blocked 4/4/1/9'));

    const v141Row = lines.find((l) => l.includes('| V1.41 |') && l.includes('历史版本'));
    assert.ok(v141Row, 'V1.41 historical row retained');
    assert.ok(v141Row.includes(V141_SIGNATURE));
    assert.ok(
      v141Row.includes('G0b real-LAN evidence absent')
        || /real-LAN evidence absent|G0b real-LAN remains incomplete/i.test(v141Row),
      'V1.41 historical must retain G0b real-LAN absent boundary',
    );

    const v140Row = lines.find((l) => l.includes('| V1.40 |') && l.includes('历史版本'));
    assert.ok(v140Row, 'V1.40 historical row retained');
    assert.ok(v140Row.includes(V140_SIGNATURE));

    // Compact G0b acceptance section (historical harness) still present
    assert.ok(/G0b/i.test(readme));
    assert.ok(readme.includes('LINKE_REAL_G0B_UPLOAD_ACCEPTANCE'));
    assert.ok(
      readme.includes('g0b-real-controller-runner')
        || readme.includes('g0b-real-endpoint-runner')
        || readme.includes('test/helpers/g0b-real'),
    );
    assert.ok(
      /default.*skip|gate.*closed|hardware/i.test(readme),
    );
    assert.ok(
      /no PASS report|report absent|real-LAN evidence absent|无.*PASS.*报告/i.test(readme),
    );
    // Must not claim G0b real-LAN complete (historical boundary)
    assert.ok(!readme.includes('G0b real-LAN complete')
      || /G0b real-LAN remains incomplete|不得.*G0b real-LAN complete|not G0b real-LAN complete/.test(readme));
    // Must not claim G0c real-LAN complete either (use remains-incomplete / evidence-absent)
    assert.ok(
      !/G0c real-LAN complete/i.test(readme)
      || /G0c real-LAN remains incomplete|G0c real-LAN evidence absent/.test(readme),
    );
  });
});
