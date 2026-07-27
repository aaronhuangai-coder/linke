/**
 * V1.42 C8 — G0c auto child-process harness (NOT real-LAN / NOT Gold).
 * Topology: independent controller child + two independent endpoint children.
 * Scenarios: completed, rollback, pre-anchor-cancel, cross-device-deny,
 * disconnect-recovery, global-backpressure.
 * Default CI gate closed for real-LAN; report must remain absent.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import { buildGoldReadinessReport } from '../src/gold-readiness.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMON_PATH = join(REPO_ROOT, 'test/helpers/g0c-auto-common.js');
const CONTROLLER_PATH = join(REPO_ROOT, 'test/helpers/g0c-auto-controller-runner.js');
const ENDPOINT_PATH = join(REPO_ROOT, 'test/helpers/g0c-auto-endpoint-runner.js');
const REPORT_ABS = join(
  REPO_ROOT,
  'docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md',
);
const README_PATH = join(REPO_ROOT, 'README.md');

const V144_CANDIDATE_SIGNATURE =
  'V1.44 real NAS evidence-validation candidate';
const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';
const V142_SIGNATURE =
  'V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation';
const V141_SIGNATURE =
  'V1.41 G0b resumable manifest v2 snapshot upload implementation';

const EXPECTED_AUTO_SCENARIOS = Object.freeze([
  'completed',
  'rollback',
  'pre-anchor-cancel',
  'cross-device-deny',
  'disconnect-recovery',
  'global-backpressure',
]);

/** @type {string[]} */
const tempDirs = [];

after(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Dynamic import of a C8 helper — must exist for GREEN; RED fails with ERR_MODULE_NOT_FOUND.
 * @param {string} absPath
 */
async function importHelper(absPath) {
  return import(absPath);
}

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 */
/**
 * Child env: single no-warning color setting only (no FORCE_COLOR + NO_COLOR pair).
 * @param {Record<string, string | undefined>} env
 */
function childEnv(env = {}) {
  const base = { ...process.env, ...env };
  // Prefer NO_COLOR alone; drop FORCE_COLOR to avoid Node mutual-warning.
  delete base.FORCE_COLOR;
  base.NO_COLOR = '1';
  base.LINKE_REAL_G0C_RESTORE_ACCEPTANCE = Object.prototype.hasOwnProperty.call(
    env,
    'LINKE_REAL_G0C_RESTORE_ACCEPTANCE',
  )
    ? env.LINKE_REAL_G0C_RESTORE_ACCEPTANCE
    : '';
  base.LINKE_G0C_AUTO_ACCEPTANCE = Object.prototype.hasOwnProperty.call(
    env,
    'LINKE_G0C_AUTO_ACCEPTANCE',
  )
    ? env.LINKE_G0C_AUTO_ACCEPTANCE
    : '';
  return base;
}

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 */
function runNodeChild(args, env = {}, { cwd = REPO_ROOT, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, pid: child.pid });
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * @param {string} text
 */
function assertNoSecretLeak(text) {
  assert.doesNotMatch(
    text,
    /token|fingerprint|BEGIN |private key|\/Users\/|127\.0\.0\.1|https?:\/\//i,
  );
}

/**
 * Parse single-line sanitized JSON stdout from a child.
 * stderr must be exact empty (no warning filters).
 * @param {{ stdout: string, stderr: string, code: number | null, pid?: number }} child
 * @param {string} label
 */
function parseOneSanitizedLine(child, label) {
  assert.notEqual(child.code, null, `${label}: timed out`);
  const lines = child.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `${label}: expected one stdout line, got ${lines.length}; stderr=${child.stderr}`);
  assert.equal(child.stderr, '', `${label}: stderr must be exact empty; got ${JSON.stringify(child.stderr)}`);
  const result = JSON.parse(lines[0]);
  assertNoSecretLeak(child.stdout);
  assertNoSecretLeak(JSON.stringify(result));
  return result;
}

/**
 * One-shot child exit capture installed immediately after spawn.
 * close is recorded as soon as it fires; waitForExit only arms the kill deadline.
 * If close already happened, waitForExit returns the real code/buffers without faking timeout.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => { stdout: string, stderr: string }} getBuffers
 */
function installChildExitCapture(child, getBuffers) {
  let settled = false;
  /** @type {{ code: number | null, stdout: string, stderr: string } | null} */
  let result = null;
  /** @type {((r: { code: number | null, stdout: string, stderr: string }) => void) | null} */
  let pendingResolve = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let deadlineTimer = null;

  const settle = (code) => {
    if (settled) return;
    settled = true;
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    const buffers = getBuffers();
    result = { code, stdout: buffers.stdout, stderr: buffers.stderr };
    if (pendingResolve) {
      pendingResolve(result);
      pendingResolve = null;
    }
  };

  // Capture close immediately so a fast child cannot drop the event before waitForExit.
  child.once('close', (code) => settle(code));

  return {
    /**
     * Wait for exit. Arms kill deadline only when called (after stop signal).
     * Already-closed children resolve immediately with the real exit code.
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
     */
    waitForExit({ timeoutMs = 30_000 } = {}) {
      if (settled && result) {
        return Promise.resolve(result);
      }
      return new Promise((resolve) => {
        pendingResolve = resolve;
        deadlineTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          settle(null);
        }, timeoutMs);
      });
    },
  };
}

describe('G0c auto-common exact public surface', () => {
  it('exports exact gates, scenarios, schema helpers; import zero side effects', async () => {
    const common = await importHelper(COMMON_PATH);
    assert.equal(common.REAL_GATE_ENV, 'LINKE_REAL_G0C_RESTORE_ACCEPTANCE');
    assert.equal(common.REAL_GATE_VALUE, 'enabled');
    assert.equal(common.AUTO_GATE_ENV, 'LINKE_G0C_AUTO_ACCEPTANCE');
    assert.equal(common.AUTO_GATE_VALUE, 'enabled');
    assert.deepEqual([...common.AUTO_SCENARIOS], [...EXPECTED_AUTO_SCENARIOS]);
    assert.equal(
      common.REAL_REPORT_RELATIVE_PATH,
      'docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md',
    );
    assert.equal(typeof common.assertRealGate, 'function');
    assert.equal(typeof common.assertAutoGate, 'function');
    assert.equal(typeof common.assertAutoScenario, 'function');
    assert.equal(typeof common.serializeSanitizedResult, 'function');
    assert.equal(typeof common.validateSanitizedResult, 'function');
    assert.equal(typeof common.assertNoSensitiveData, 'function');
    assert.equal(typeof common.sanitizedFailure, 'function');
    assert.equal(typeof common.atomicWritePrivateJson, 'function');
    assert.equal(typeof common.readPrivateJson, 'function');
    assert.equal(typeof common.assertDedicatedRunDirectory, 'function');
    assert.equal(typeof common.validateAutoEndpointBundle, 'function');

    assert.throws(() => common.assertRealGate({}), (e) => e instanceof LinkeError);
    assert.throws(() => common.assertAutoGate({}), (e) => e instanceof LinkeError);
    assert.equal(
      common.assertAutoGate({ [common.AUTO_GATE_ENV]: common.AUTO_GATE_VALUE }),
      true,
    );
    assert.equal(
      common.assertRealGate({ [common.REAL_GATE_ENV]: common.REAL_GATE_VALUE }),
      true,
    );
    for (const s of EXPECTED_AUTO_SCENARIOS) {
      assert.equal(common.assertAutoScenario(s), s);
    }
    assert.throws(() => common.assertAutoScenario('fake-real-lan'));
  });

  it('import common/controller/endpoint emits zero stdout and installs no listeners', async () => {
    const probe = await runNodeChild(
      [
        '-e',
        "import('./test/helpers/g0c-auto-common.js');"
          + "import('./test/helpers/g0c-auto-controller-runner.js');"
          + "import('./test/helpers/g0c-auto-endpoint-runner.js');"
          + "console.error('G0C_PROBE_OK');",
      ],
      {},
    );
    assert.equal(probe.stdout.trim(), '');
    assert.match(probe.stderr, /G0C_PROBE_OK/);
    assertNoSecretLeak(probe.stderr);
  });
});

describe('G0c controller/endpoint runners exact exports and fail-closed main', () => {
  it('controller runner exports createAutoControllerHarness + runControllerHarnessMain', async () => {
    const mod = await importHelper(CONTROLLER_PATH);
    assert.equal(typeof mod.createAutoControllerHarness, 'function');
    assert.equal(typeof mod.runControllerHarnessMain, 'function');
  });

  it('endpoint runner exports createAutoEndpointHarness + runEndpointHarnessMain', async () => {
    const mod = await importHelper(ENDPOINT_PATH);
    assert.equal(typeof mod.createAutoEndpointHarness, 'function');
    assert.equal(typeof mod.runEndpointHarnessMain, 'function');
  });

  it('direct controller main without auto/real gate: one sanitized FAIL line', async () => {
    const child = await runNodeChild([CONTROLLER_PATH], {
      LINKE_REAL_G0C_RESTORE_ACCEPTANCE: '',
      LINKE_G0C_AUTO_ACCEPTANCE: '',
    });
    const line = parseOneSanitizedLine(child, 'controller-no-gate');
    assert.equal(line.role, 'controller');
    assert.equal(line.status, 'FAIL');
    assert.equal(line.phase, 'main');
    assert.equal(child.code, 1);
  });

  it('direct endpoint main without auto gate: one sanitized FAIL line', async () => {
    const child = await runNodeChild([ENDPOINT_PATH, 'auto', 'completed'], {
      LINKE_REAL_G0C_RESTORE_ACCEPTANCE: '',
      LINKE_G0C_AUTO_ACCEPTANCE: '',
    });
    const line = parseOneSanitizedLine(child, 'endpoint-no-gate');
    assert.equal(line.role, 'endpoint');
    assert.equal(line.status, 'FAIL');
    assert.equal(child.code, 1);
  });

  it('endpoint rejects extra argv even with auto gate', async () => {
    const child = await runNodeChild(
      [ENDPOINT_PATH, 'auto', 'completed', 'extra'],
      { LINKE_G0C_AUTO_ACCEPTANCE: 'enabled' },
    );
    const line = parseOneSanitizedLine(child, 'endpoint-extra-argv');
    assert.equal(line.role, 'endpoint');
    assert.equal(line.status, 'FAIL');
    assert.equal(child.code, 1);
  });
});

describe('G0c auto child-process topology + six scenarios', () => {
  it('spawns controller + two endpoint children with distinct PIDs; runs all six production scenarios', async () => {
    const common = await importHelper(COMMON_PATH);
    const controllerMod = await importHelper(CONTROLLER_PATH);

    /** @type {Array<{ scenario: string, controllerPid: number, endpointAPid: number, endpointBPid: number, result: object }>} */
    const topology = [];

    for (const scenario of EXPECTED_AUTO_SCENARIOS) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-g0c-data-'));
      await chmod(dataDir, 0o700);
      tempDirs.push(dataDir);
      const runDir = await mkdtemp(join(tmpdir(), 'linke-g0c-run-'));
      await chmod(runDir, 0o700);
      tempDirs.push(runDir);

      // Controller child: serve mode writes private bundle + seeds tasks, stays up.
      const controllerChild = spawn(
        process.execPath,
        [CONTROLLER_PATH, 'auto', 'serve', scenario],
        {
          cwd: runDir,
          env: childEnv({
            LINKE_G0C_AUTO_ACCEPTANCE: common.AUTO_GATE_VALUE,
            LINKE_REAL_G0C_RESTORE_ACCEPTANCE: '',
            LINKE_G0C_AUTO_DATA_DIR: dataDir,
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let controllerStdout = '';
      let controllerStderr = '';
      controllerChild.stdout.on('data', (c) => {
        controllerStdout += c;
      });
      controllerChild.stderr.on('data', (c) => {
        controllerStderr += c;
      });
      // Install close capture immediately — before any await — so fast exits are not lost.
      const controllerExitCapture = installChildExitCapture(controllerChild, () => ({
        stdout: controllerStdout,
        stderr: controllerStderr,
      }));

      // Wait for ready marker written by controller child.
      const readyPath = join(runDir, '.g0c-auto-ready.json');
      const readyDeadline = Date.now() + 60_000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await access(readyPath);
          break;
        } catch {
          if (Date.now() > readyDeadline) {
            try {
              controllerChild.kill('SIGKILL');
            } catch {
              // ignore
            }
            assert.fail(
              `controller ready timeout for ${scenario}; stdout=${controllerStdout} stderr=${controllerStderr}`,
            );
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      const epEnv = {
        LINKE_G0C_AUTO_ACCEPTANCE: common.AUTO_GATE_VALUE,
        LINKE_REAL_G0C_RESTORE_ACCEPTANCE: '',
      };

      /** @type {{ code: number | null, stdout: string, stderr: string, pid: number | undefined }} */
      let endpointA;
      /** @type {{ code: number | null, stdout: string, stderr: string, pid: number | undefined } | null} */
      let endpointA2 = null;
      /** @type {{ code: number | null, stdout: string, stderr: string, pid: number | undefined }} */
      let endpointB;

      if (scenario === 'disconnect-recovery') {
        // Four-PID topology: controller + A1 (partial) + A2 (resume) + B peer.
        const endpointBPromise = runNodeChild(
          [ENDPOINT_PATH, 'auto', scenario, 'device-b'],
          epEnv,
          { cwd: runDir, timeoutMs: 90_000 },
        );
        endpointA = await runNodeChild(
          [ENDPOINT_PATH, 'auto', scenario, 'device-a'],
          epEnv,
          { cwd: runDir, timeoutMs: 90_000 },
        );
        const a1 = parseOneSanitizedLine(endpointA, `endpointA1-${scenario}`);
        assert.equal(a1.status, 'PASS', `A1 ${JSON.stringify(a1)} ${endpointA.stderr}`);
        assert.equal(a1.promptHandled, 'durable-interrupted');
        assert.equal(a1.flag, true);
        assert.equal(a1.count, 1, 'first child claimCount must be exactly 1');

        endpointA2 = await runNodeChild(
          [ENDPOINT_PATH, 'auto', scenario, 'device-a'],
          epEnv,
          { cwd: runDir, timeoutMs: 90_000 },
        );
        endpointB = await endpointBPromise;
        assert.notEqual(endpointA.pid, endpointA2.pid, 'A1/A2 must be distinct restart PIDs');
        const a2 = parseOneSanitizedLine(endpointA2, `endpointA2-${scenario}`);
        assert.equal(a2.status, 'PASS', `A2 ${JSON.stringify(a2)} ${endpointA2.stderr}`);
        assert.equal(a2.promptHandled, 'completed');
        assert.equal(a2.count, 0, 'resume child: claimCount must be exactly 0');
        const b = parseOneSanitizedLine(endpointB, `endpointB-${scenario}`);
        assert.equal(b.status, 'PASS');
        assert.equal(b.promptHandled, 'peer-ok');
      } else {
        const endpointAPromise = runNodeChild(
          [ENDPOINT_PATH, 'auto', scenario, 'device-a'],
          epEnv,
          { cwd: runDir, timeoutMs: 90_000 },
        );
        const endpointBPromise = runNodeChild(
          [ENDPOINT_PATH, 'auto', scenario, 'device-b'],
          epEnv,
          { cwd: runDir, timeoutMs: 90_000 },
        );
        [endpointA, endpointB] = await Promise.all([endpointAPromise, endpointBPromise]);
      }

      assert.ok(
        Number.isInteger(controllerChild.pid) && controllerChild.pid > 0,
        `${scenario}: controller pid`,
      );
      assert.ok(Number.isInteger(endpointA.pid) && endpointA.pid > 0, `${scenario}: endpoint A pid`);
      assert.ok(Number.isInteger(endpointB.pid) && endpointB.pid > 0, `${scenario}: endpoint B pid`);
      assert.notEqual(
        endpointA.pid,
        endpointB.pid,
        `${scenario}: endpoint A/B must be distinct child PIDs`,
      );
      assert.notEqual(
        controllerChild.pid,
        endpointA.pid,
        `${scenario}: controller != endpoint A`,
      );
      assert.notEqual(
        controllerChild.pid,
        endpointB.pid,
        `${scenario}: controller != endpoint B`,
      );
      if (endpointA2) {
        assert.notEqual(controllerChild.pid, endpointA2.pid);
        assert.notEqual(endpointB.pid, endpointA2.pid);
      }

      // Signal controller to shut down. Deadline starts only after stop is written.
      await writeFile(join(runDir, '.g0c-auto-stop'), 'stop\n', { mode: 0o600 });
      const controllerExit = await controllerExitCapture.waitForExit({ timeoutMs: 30_000 });

      const controllerLine = parseOneSanitizedLine(
        {
          ...controllerExit,
          pid: controllerChild.pid,
        },
        `controller-${scenario}`,
      );
      assert.equal(controllerLine.role, 'controller');
      assert.equal(controllerLine.status, 'PASS');
      assert.equal(controllerLine.phase, scenario);

      // Primary endpoint assertions are role-dependent per scenario.
      if (scenario === 'cross-device-deny') {
        const a = parseOneSanitizedLine(endpointA, `endpointA-${scenario}`);
        const b = parseOneSanitizedLine(endpointB, `endpointB-${scenario}`);
        assert.equal(a.status, 'PASS', `A ${JSON.stringify(a)} ${endpointA.stderr}`);
        assert.equal(b.status, 'PASS', `B ${JSON.stringify(b)} ${endpointB.stderr}`);
        assert.equal(a.phase, scenario);
        assert.equal(a.code, ERROR_CODES.RESTORE_TASK_NOT_FOUND);
        assert.equal(a.flag, true);
        assert.equal(endpointA.code, 0);
        assert.equal(endpointB.code, 0);
        topology.push({
          scenario,
          controllerPid: controllerChild.pid,
          endpointAPid: endpointA.pid,
          endpointBPid: endpointB.pid,
          result: a,
        });
      } else if (scenario === 'global-backpressure') {
        const a = parseOneSanitizedLine(endpointA, `endpointA-${scenario}`);
        const b = parseOneSanitizedLine(endpointB, `endpointB-${scenario}`);
        assert.equal(a.status, 'PASS', `A ${JSON.stringify(a)} ${endpointA.stderr}`);
        assert.equal(a.phase, scenario);
        assert.equal(a.code, ERROR_CODES.RESTORE_BACKPRESSURE);
        assert.equal(a.flag, true);
        assert.equal(a.promptHandled, 'backpressure-then-ok');
        assert.ok(
          Number.isInteger(a.count) && a.count >= 1 && a.count <= 30,
          `Retry-After bound count: ${a.count}`,
        );
        assert.equal(b.status, 'PASS', `B ${JSON.stringify(b)}`);
        assert.equal(endpointA.code, 0);
        topology.push({
          scenario,
          controllerPid: controllerChild.pid,
          endpointAPid: endpointA.pid,
          endpointBPid: endpointB.pid,
          result: a,
        });
      } else if (scenario === 'disconnect-recovery') {
        // Assertions already applied on A1/A2 above.
        topology.push({
          scenario,
          controllerPid: controllerChild.pid,
          endpointAPid: endpointA2?.pid ?? endpointA.pid,
          endpointBPid: endpointB.pid,
          result: { status: 'PASS', promptHandled: 'completed', count: 0 },
        });
      } else if (scenario === 'completed') {
        const a = parseOneSanitizedLine(endpointA, `endpointA-${scenario}`);
        const b = parseOneSanitizedLine(endpointB, `endpointB-${scenario}`);
        assert.equal(a.status, 'PASS', `A ${JSON.stringify(a)} ${endpointA.stderr}`);
        assert.equal(a.phase, scenario);
        assert.equal(a.promptHandled, 'completed');
        assert.equal(a.flag, true, 'controller cleaned terminal');
        assert.equal(b.status, 'PASS');
        assert.equal(endpointA.code, 0);
        topology.push({
          scenario,
          controllerPid: controllerChild.pid,
          endpointAPid: endpointA.pid,
          endpointBPid: endpointB.pid,
          result: a,
        });
      } else if (scenario === 'rollback') {
        const a = parseOneSanitizedLine(endpointA, `endpointA-${scenario}`);
        const b = parseOneSanitizedLine(endpointB, `endpointB-${scenario}`);
        assert.equal(a.status, 'PASS', `A ${JSON.stringify(a)} ${endpointA.stderr}`);
        assert.equal(a.phase, scenario);
        assert.equal(a.promptHandled, 'rolled-back');
        assert.notEqual(a.promptHandled, 'completed');
        assert.equal(a.flag, true);
        assert.equal(b.status, 'PASS');
        assert.equal(endpointA.code, 0);
        topology.push({
          scenario,
          controllerPid: controllerChild.pid,
          endpointAPid: endpointA.pid,
          endpointBPid: endpointB.pid,
          result: a,
        });
      } else if (scenario === 'pre-anchor-cancel') {
        const a = parseOneSanitizedLine(endpointA, `endpointA-${scenario}`);
        const b = parseOneSanitizedLine(endpointB, `endpointB-${scenario}`);
        assert.equal(a.status, 'PASS', `A ${JSON.stringify(a)} ${endpointA.stderr}`);
        assert.equal(a.phase, scenario);
        assert.equal(a.promptHandled, 'cancelled-local');
        assert.notEqual(a.promptHandled, 'completed');
        assert.equal(a.flag, true);
        assert.equal(b.status, 'PASS');
        assert.equal(endpointA.code, 0);
        topology.push({
          scenario,
          controllerPid: controllerChild.pid,
          endpointAPid: endpointA.pid,
          endpointBPid: endpointB.pid,
          result: a,
        });
      } else {
        assert.fail(`unexpected scenario ${scenario}`);
      }

      // Normal-path controller source must not contain harness DI patches.
      if (scenario === 'completed') {
        const ctrlSrc = await readFile(CONTROLLER_PATH, 'utf8');
        assert.ok(!ctrlSrc.includes('function pickExact'), 'no pickExact DI');
        assert.ok(
          !ctrlSrc.includes('chunkSize: RESTORE_CHUNK_SIZE'),
          'no chunkSize wire inject in controller harness',
        );
      }

      // Programmatic surface also available for controller factory (not real-LAN).
      assert.equal(typeof controllerMod.createAutoControllerHarness, 'function');
    }

    assert.equal(topology.length, 6);
    // All six scenarios produced distinct dual-endpoint topologies
    for (const row of topology) {
      assert.notEqual(row.endpointAPid, row.endpointBPid);
      assert.equal(row.result.status, 'PASS');
    }
  });

  it('fast-exit child: close before later await returns real code (no lost event / no fake timeout)', async () => {
    // Deterministic regression for the historical race: writeFile/await then on('close').
    // Child exits immediately; we deliberately wait until close has already fired, then await.
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify({ role: 'probe', status: 'PASS' }) + '\\n'); process.exit(0);",
      ],
      {
        cwd: REPO_ROOT,
        env: childEnv({}),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const capture = installChildExitCapture(child, () => ({ stdout, stderr }));

    // Ensure the process has fully closed before waitForExit (close-before-await).
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(undefined);
        return;
      }
      child.once('exit', () => resolve(undefined));
      child.once('error', reject);
    });
    // Yield so the 'close' listener can run before we call waitForExit.
    await new Promise((r) => setImmediate(r));
    assert.notEqual(child.exitCode, null, 'precondition: child must already have exited');

    const started = Date.now();
    const exit = await capture.waitForExit({ timeoutMs: 30_000 });
    const elapsedMs = Date.now() - started;

    assert.equal(exit.code, 0, `must return real exit code, not timeout null; stderr=${exit.stderr}`);
    assert.ok(
      elapsedMs < 5_000,
      `must not wait full 30s deadline after close already fired; elapsedMs=${elapsedMs}`,
    );
    assert.equal(exit.stderr, '', `stderr must be exact empty; got ${JSON.stringify(exit.stderr)}`);
    const line = parseOneSanitizedLine(
      { code: exit.code, stdout: exit.stdout, stderr: exit.stderr, pid: child.pid },
      'fast-exit-close-before-await',
    );
    assert.equal(line.role, 'probe');
    assert.equal(line.status, 'PASS');
  });
});

describe('G0c real-LAN gate default skip + report absent', () => {
  it('real-LAN acceptance report must be absent (no hardware PASS / no fake report)', async () => {
    await assert.rejects(
      access(REPORT_ABS),
      (e) => e && e.code === 'ENOENT',
    );
  });

  it('importing harness test module does not create real-LAN report', async () => {
    await assert.rejects(access(REPORT_ABS), (e) => e && e.code === 'ENOENT');
  });

  it('real gate off: createReal* paths fail-closed when exported', async () => {
    const controllerMod = await importHelper(CONTROLLER_PATH);
    if (typeof controllerMod.createRealControllerHarness === 'function') {
      await assert.rejects(
        controllerMod.createRealControllerHarness({ env: {} }),
        (e) => e instanceof LinkeError,
      );
    }
    const endpointMod = await importHelper(ENDPOINT_PATH);
    if (typeof endpointMod.createRealEndpointHarness === 'function') {
      await assert.rejects(
        endpointMod.createRealEndpointHarness({ env: {} }),
        (e) => e instanceof LinkeError,
      );
    }
  });
});

describe('G0c V1.44 version / Gold / README honesty (auto harness ≠ real-LAN)', () => {
  it('LINKE_RELEASE_VERSION is exactly V1.44 (signature not embedded)', () => {
    assert.equal(LINKE_RELEASE_VERSION, 'V1.44');
    assert.notEqual(LINKE_RELEASE_VERSION, V144_CANDIDATE_SIGNATURE);
    assert.notEqual(LINKE_RELEASE_VERSION, V143_SIGNATURE);
    assert.notEqual(LINKE_RELEASE_VERSION, V142_SIGNATURE);
    assert.ok(!LINKE_RELEASE_VERSION.includes('G0c'));
    assert.ok(!LINKE_RELEASE_VERSION.includes(V143_SIGNATURE));
    assert.ok(!LINKE_RELEASE_VERSION.includes(V142_SIGNATURE));
  });

  it('Gold remains blocked 4/4/1/9; statuses frozen; V1.44 current + V1.43/V1.42 evidence honest', () => {
    const report = buildGoldReadinessReport({ now: new Date('2026-07-23T12:00:00.000Z') });
    assert.equal(report.version, 'V1.44');
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
    assert.ok(evidenceText.includes(V143_SIGNATURE), 'historical V1.43 rotation signature evidence retained');
    assert.ok(evidenceText.includes('explicit manual rotation delivered'));
    assert.ok(evidenceText.includes('no automatic rotation'));
    assert.ok(evidenceText.includes('no automatic scheduling'));
    assert.ok(evidenceText.includes(V142_SIGNATURE), 'retain V1.42 G0c historical baseline');
    assert.ok(evidenceText.includes(V141_SIGNATURE), 'retain V1.41 historical baseline');
    assert.ok(
      evidenceText.includes('auto harness complete ≠ real-LAN complete')
        || evidenceText.includes('auto harness complete does not equal real-LAN complete')
        || /auto harness complete is not real-LAN complete/i.test(evidenceText),
    );
    assert.ok(
      evidenceText.includes('G0c real-LAN evidence absent')
        || evidenceText.includes('real-LAN evidence absent'),
    );
    assert.ok(
      evidenceText.includes('G0c real-LAN remains incomplete')
        || evidenceText.includes('G0c real-LAN evidence absent'),
    );
    assert.ok(evidenceText.includes('not Gold') || evidenceText.includes('Gold remains blocked'));
    assert.ok(evidenceText.includes('Gold remains blocked 4/4/1/9'));
    assert.ok(hardening.nextStep.startsWith('V1.43'));
    assert.ok(hardening.nextStep.includes(V143_SIGNATURE));
    assert.ok(hardening.nextStep.includes(V142_SIGNATURE));
    assert.ok(hardening.nextStep.includes(V141_SIGNATURE)
      || /V1\.41 historical/.test(hardening.nextStep));
    assert.ok(/real-LAN evidence absent|G0c real-LAN evidence absent/i.test(hardening.nextStep));
    assert.ok(/Gold remains blocked 4\/4\/1\/9/.test(hardening.nextStep));
  });

  it('README current surface is V1.44 honest; V1.43 rotation historical; V1.42 G0c historical; auto ≠ real-LAN', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const firstLine = readme.split('\n')[0].trim();
    assert.equal(firstLine, '# Linke V1.44');
    assert.ok(readme.includes('**当前版本：V1.44**'));

    const lines = readme.split('\n');
    const currentRow = lines.find((l) => l.includes('| V1.44 |') && l.includes('当前版本'));
    assert.ok(currentRow, 'V1.44 current version table row');
    assert.ok(currentRow.includes(V144_CANDIDATE_SIGNATURE));
    assert.ok(currentRow.includes('exact V1.44 hardware evidence pending'));
    assert.ok(currentRow.includes('real-nas-remote-backup remains blocked'));
    assert.ok(currentRow.includes('not Gold'));
    assert.ok(currentRow.includes('Gold remains blocked 4/4/1/9'));
    assert.ok(!/G0c real-LAN complete/i.test(currentRow));

    const v143Row = lines.find((l) => l.includes('| V1.43 |') && l.includes('历史版本'));
    assert.ok(v143Row, 'V1.43 historical row retained');
    assert.ok(v143Row.includes(V143_SIGNATURE));
    assert.ok(v143Row.includes('explicit manual rotation delivered'));
    assert.ok(/no automatic rotation/i.test(v143Row));
    assert.ok(/no automatic scheduling/i.test(v143Row));
    assert.ok(v143Row.includes('not production-hardening ready'));
    assert.ok(v143Row.includes('Gold remains blocked 4/4/1/9'));
    assert.ok(v143Row.includes('G0c real-LAN evidence absent'));

    const v142Row = lines.find((l) => l.includes('| V1.42 |') && l.includes('历史版本'));
    assert.ok(v142Row, 'V1.42 historical row retained');
    assert.ok(v142Row.includes(V142_SIGNATURE));
    assert.ok(
      v142Row.includes('auto harness complete is not real-LAN complete')
        || /auto.*not.*real-LAN complete/i.test(v142Row)
        || v142Row.includes('auto harness complete ≠ real-LAN complete'),
    );
    assert.ok(
      v142Row.includes('G0c real-LAN evidence absent')
        || /real-LAN evidence absent/i.test(v142Row),
    );

    const v141Row = lines.find((l) => l.includes('| V1.41 |') && l.includes('历史版本'));
    assert.ok(v141Row, 'V1.41 historical row retained');
    assert.ok(v141Row.includes(V141_SIGNATURE));

    assert.ok(/G0c/i.test(readme));
    assert.ok(readme.includes('LINKE_REAL_G0C_RESTORE_ACCEPTANCE'));
    assert.ok(
      readme.includes('g0c-auto-controller-runner')
        || readme.includes('g0c-auto-endpoint-runner')
        || readme.includes('test/helpers/g0c-auto'),
    );
    assert.ok(
      !/G0c real-LAN complete/i.test(readme)
      || /G0c real-LAN remains incomplete|G0c real-LAN evidence absent/.test(readme),
    );
  });
});
