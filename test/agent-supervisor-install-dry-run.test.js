import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
const EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY = Object.freeze({
  state: 'blocked',
  blockedCount: 4,
  blockers: [
    'real-install-not-implemented',
    'launchd-install-blocked',
    'supervisor-start-blocked',
    'production-boundaries-incomplete',
  ],
  readyCount: 0,
  checkedCount: 4,
  failOnBlockedExitCode: 2,
});
const EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW = Object.freeze({
  mode: 'dry-run-only',
  state: 'blocked',
  actions: [
    {
      id: 'render-launch-agent-plist',
      description: 'Render a launch agent plist preview with redacted config path.',
      command: 'generate launchd plist preview',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
    {
      id: 'write-launch-agent-plist',
      description: 'Future installer would write a launch agent plist to a user LaunchAgents location.',
      command: 'write launch agent plist to [redacted]',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
    {
      id: 'load-launch-agent',
      description: 'Future installer would ask launchd to load the agent after explicit operator approval.',
      command: 'launchctl bootstrap gui/[redacted] [redacted]',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
    {
      id: 'start-launch-agent',
      description: 'Future installer would start the launch agent after successful load.',
      command: 'launchctl kickstart gui/[redacted]/[redacted]',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
  ],
  safety: {
    executableResolved: false,
    configPathResolved: false,
    plistPathResolved: false,
    launchctlCommandsRunnable: false,
    launchctlCalled: false,
    launchdFileWritten: false,
    metadataWritten: false,
  },
});

const EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT = Object.freeze({
  mode: 'dry-run-only',
  state: 'blocked',
  blockedCount: 6,
  readyCount: 0,
  checkedCount: 6,
  checks: [
    {
      id: 'installer-implementation',
      label: 'Real installer implementation',
      status: 'blocked',
      blockerCode: 'real-install-not-implemented',
      requiredForInstall: true,
      evidence: 'No install command or launchd write path exists in this release.',
    },
    {
      id: 'launchd-lifecycle',
      label: 'Launchd install/start lifecycle',
      status: 'blocked',
      blockerCode: 'launchd-lifecycle-blocked',
      requiredForInstall: true,
      evidence: 'launchctl execution, plist writes, and daemon start remain disabled.',
    },
    {
      id: 'operator-approval',
      label: 'Explicit operator approval gate',
      status: 'blocked',
      blockerCode: 'operator-approval-required',
      requiredForInstall: true,
      evidence: 'No approved write path or production install confirmation flow exists.',
    },
    {
      id: 'secret-management',
      label: 'Production secret management',
      status: 'blocked',
      blockerCode: 'secret-management-incomplete',
      requiredForInstall: true,
      evidence: 'Secret rotation, protected storage, and secret handling are not production-grade.',
    },
    {
      id: 'monitoring-watchdog',
      label: 'Monitoring and watchdog',
      status: 'blocked',
      blockerCode: 'monitoring-watchdog-incomplete',
      requiredForInstall: true,
      evidence: 'No watchdog, health recovery loop, alerting, or managed daemon monitoring is implemented.',
    },
    {
      id: 'rollback-recovery',
      label: 'Rollback and recovery plan',
      status: 'blocked',
      blockerCode: 'rollback-recovery-incomplete',
      requiredForInstall: true,
      evidence: 'No rollback, uninstall, or recovery supervisor lifecycle is implemented.',
    },
  ],
  safety: {
    dryRun: true,
    preflightOnly: true,
    launchctlCalled: false,
    processListRead: false,
    filesystemWritten: false,
    metadataWritten: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
    sensitiveValuesReturned: false,
  },
});

async function runAgent(args) {
  return exec('node', [agentPath, ...args]);
}

async function rejectAgent(args, expectedCode) {
  try {
    await runAgent(args);
  } catch (err) {
    assert.strictEqual(err.code, expectedCode);
    return err;
  }
  assert.fail(`Expected agent command to exit ${expectedCode}`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoSensitivePreflightEvidence(preflight) {
  for (const check of preflight.checks) {
    assert.strictEqual(typeof check.evidence, 'string');
    assert.doesNotMatch(check.evidence, /\/Users\/|\/private\/|~\/|https?:\/\//i);
    assert.doesNotMatch(check.evidence, /token|bearer|authorization|credentialRef|secret-ref|nas\.local/i);
    assert.doesNotMatch(check.evidence, /config\.json|LaunchAgents|\.plist/);
  }
}

describe('Agent supervisor-install-dry-run CLI', () => {
  it('buildSupervisorInstallDryRunPlan returns a sanitized dry-run plan without sensitive config values', async () => {
    const app = await import('../src/agent.js');
    const buildSupervisorInstallDryRunPlan = app.buildSupervisorInstallDryRunPlan;
    const buildSupervisorInstallReadinessSummary = app.buildSupervisorInstallReadinessSummary;
    const buildSupervisorInstallCommandPreview = app.buildSupervisorInstallCommandPreview;
    if (!buildSupervisorInstallDryRunPlan) {
      throw new Error('buildSupervisorInstallDryRunPlan is not defined in src/agent.js');
    }
    if (!buildSupervisorInstallReadinessSummary) {
      throw new Error('buildSupervisorInstallReadinessSummary is not defined in src/agent.js');
    }
    if (!buildSupervisorInstallCommandPreview) {
      throw new Error('buildSupervisorInstallCommandPreview is not defined in src/agent.js');
    }
    const buildSupervisorInstallPreflight = app.buildSupervisorInstallPreflight;
    if (!buildSupervisorInstallPreflight) {
      throw new Error('buildSupervisorInstallPreflight is not defined in src/agent.js');
    }

    const sourcePath = '/Users/ah/private/source';
    const endpoint = 'https://nas.local:5001';
    const credentialRef = 'nas-secret-ref';
    const plan = buildSupervisorInstallDryRunPlan({
      serverUrl: 'http://127.0.0.1:3000',
      deviceId: 'mac-main',
      launchdLabel: 'com.linke.agent.mac-main',
      scheduleSeconds: 1800,
      backupJobs: [
        { name: 'docs', sourcePath },
        { name: 'photos', sourcePath: '/Users/ah/Pictures/private' },
      ],
      excludePatterns: ['*.tmp', '.DS_Store'],
      nasTargets: [
        {
          name: 'synology-a',
          provider: 'synology',
          endpoint,
          shareName: 'backup',
          remotePath: '/private/remote',
          credentialRef,
          enabled: true,
        },
      ],
    });

    assert.strictEqual(plan.status, 'partial');
    assert.strictEqual(plan.service, 'linke');
    assert.strictEqual(plan.version, LINKE_RELEASE_VERSION);
    assert.strictEqual(plan.command, 'supervisor-install-dry-run');
    assert.deepStrictEqual(plan.supervisor, {
      state: 'not_configured',
      installPlan: 'dry_run_only',
      label: 'com.linke.agent.mac-main',
      scheduleSeconds: 1800,
      target: 'user-launch-agent',
      program: 'node src/agent.js run-once --config [redacted]',
      wouldInstall: false,
      wouldStart: false,
      wouldCallLaunchctl: false,
      wouldWriteLaunchAgent: false,
      wouldWriteMetadata: false,
    });
    assert.deepStrictEqual(plan.configSummary, {
      deviceId: 'mac-main',
      backupJobCount: 2,
      nasTargetCount: 1,
      excludePatternCount: 2,
    });
    assert.deepStrictEqual(plan.safety, {
      dryRun: true,
      configPathReturned: false,
      sourcePathsReturned: false,
      serverUrlReturned: false,
      nasEndpointsReturned: false,
      credentialRefsReturned: false,
      tokenValuesReturned: false,
      launchctlCalled: false,
      processListRead: false,
      supervisorInstalled: false,
      launchdFileWritten: false,
      metadataWritten: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
    });
    assert.deepStrictEqual(
      buildSupervisorInstallReadinessSummary(),
      EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY,
    );
    assert.deepStrictEqual(
      plan.readinessSummary,
      EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY,
    );
    assert.deepStrictEqual(
      buildSupervisorInstallCommandPreview(),
      EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
    );
    assert.deepStrictEqual(
      plan.installCommandPreview,
      EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
    );
    assert.deepStrictEqual(
      buildSupervisorInstallPreflight(),
      EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
    );
    assert.deepStrictEqual(
      plan.installPreflight,
      EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
    );
    assert.strictEqual(plan.installPreflight.blockedCount, plan.installPreflight.checks.length);
    assert.strictEqual(plan.installPreflight.readyCount, 0);
    assert.strictEqual(plan.installPreflight.checkedCount, plan.installPreflight.checks.length);
    assert.deepStrictEqual(
      plan.installPreflight.checks.map((check) => check.id),
      [
        'installer-implementation',
        'launchd-lifecycle',
        'operator-approval',
        'secret-management',
        'monitoring-watchdog',
        'rollback-recovery',
      ],
    );
    for (const check of plan.installPreflight.checks) {
      assert.strictEqual(check.status, 'blocked');
      assert.strictEqual(check.requiredForInstall, true);
      assert.strictEqual(typeof check.blockerCode, 'string');
      assert.ok(check.blockerCode.length > 0);
    }
    assert.deepStrictEqual(plan.installPreflight.safety, EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT.safety);
    assertNoSensitivePreflightEvidence(plan.installPreflight);
    for (const action of plan.installCommandPreview.actions) {
      assert.strictEqual(action.wouldRun, false);
      assert.strictEqual(action.wouldWrite, false);
      assert.strictEqual(action.sensitiveValuesReturned, false);
    }
    assert.deepStrictEqual(
      plan.installCommandPreview.actions.map((action) => action.id),
      [
        'render-launch-agent-plist',
        'write-launch-agent-plist',
        'load-launch-agent',
        'start-launch-agent',
      ],
    );
    assert.ok(Array.isArray(plan.nextSteps));
    assert.ok(plan.nextSteps.some((step) => /launchd-dry-run/.test(step)));

    const text = JSON.stringify(plan);
    assert.doesNotMatch(text, /\/Users\/ah\/private\/source|\/Users\/ah\/Pictures\/private/);
    assert.doesNotMatch(text, /127\.0\.0\.1|3000|nas\.local|5001|nas-secret-ref|private\/remote/);
    assert.doesNotMatch(text, /Authorization|Bearer/i);
  });

  it('prints sanitized JSON and does not write files next to the config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-dry-run-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'a.txt'), 'aaa');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-dry-run',
        launchdLabel: 'com.linke.agent.install-dry-run',
        scheduleSeconds: 900,
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
        nasTargets: [
          {
            name: 'ugreen-a',
            provider: 'ugreen',
            endpoint: 'https://ugreen.local',
            shareName: 'backup',
            remotePath: '/private/remote',
            credentialRef: 'ugreen-ref',
          },
        ],
      }),
    );

    try {
      const { stdout, stderr } = await runAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--token',
        'unused-local-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.command, 'supervisor-install-dry-run');
      assert.strictEqual(body.supervisor.state, 'not_configured');
      assert.strictEqual(body.supervisor.wouldInstall, false);
      assert.strictEqual(body.supervisor.wouldCallLaunchctl, false);
      assert.deepStrictEqual(
        body.readinessSummary,
        EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY,
      );
      assert.deepStrictEqual(
        body.installCommandPreview,
        EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
      );
      assert.deepStrictEqual(
        body.installPreflight,
        EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
      );
      assert.strictEqual(body.installPreflight.safety.dryRun, true);
      assert.strictEqual(body.installPreflight.safety.preflightOnly, true);
      assert.strictEqual(body.installPreflight.safety.launchctlCalled, false);
      assert.strictEqual(body.installPreflight.safety.processListRead, false);
      assert.strictEqual(body.installPreflight.safety.filesystemWritten, false);
      assert.strictEqual(body.installPreflight.safety.metadataWritten, false);
      assert.strictEqual(body.installPreflight.safety.nasConnected, false);
      assert.strictEqual(body.installPreflight.safety.backupTriggered, false);
      assert.strictEqual(body.installPreflight.safety.restoreTriggered, false);
      assert.strictEqual(body.installPreflight.safety.remoteCommandExecuted, false);
      assert.strictEqual(body.installPreflight.safety.sensitiveValuesReturned, false);
      assertNoSensitivePreflightEvidence(body.installPreflight);
      assert.strictEqual(body.installCommandPreview.safety.launchctlCalled, false);
      assert.strictEqual(body.installCommandPreview.safety.launchdFileWritten, false);
      assert.strictEqual(body.installCommandPreview.safety.metadataWritten, false);
      assert.strictEqual(body.safety.launchctlCalled, false);
      assert.strictEqual(body.safety.processListRead, false);
      assert.strictEqual(body.safety.launchdFileWritten, false);
      assert.strictEqual(body.safety.nasConnected, false);
      assert.strictEqual(body.configSummary.backupJobCount, 1);
      assert.strictEqual(body.configSummary.nasTargetCount, 1);

      assert.doesNotMatch(stdout, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(stdout, /private-source|config\.json|127\.0\.0\.1|3000|ugreen\.local|ugreen-ref|unused-local-token|Bearer/i);
      assert.deepStrictEqual((await readdir(dataDir)).sort(), ['config.json', 'private-source']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prints only sanitized readinessSummary with --readiness-summary', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-summary-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-summary',
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
        nasTargets: [
          {
            name: 'synology-a',
            provider: 'synology',
            endpoint: 'https://synology.local',
            shareName: 'backup',
            remotePath: '/private/remote',
            credentialRef: 'synology-ref',
          },
        ],
      }),
    );

    try {
      const { stdout, stderr } = await runAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        '--token',
        'unused-summary-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(body, EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY);
      assert.strictEqual(body.supervisor, undefined);
      assert.strictEqual(body.configSummary, undefined);
      assert.strictEqual(body.installCommandPreview, undefined);
      assert.strictEqual(body.installPreflight, undefined);
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(stdout, /private-source|config\.json|127\.0\.0\.1|3000|synology\.local|synology-ref|unused-summary-token|Bearer/i);
      assert.deepStrictEqual((await readdir(dataDir)).sort(), ['config.json', 'private-source']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 2 with full sanitized JSON when --fail-on-blocked is used', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-fail-full-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-fail-full',
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
      }),
    );

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--fail-on-blocked',
      ], 2);
      const body = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.strictEqual(body.command, 'supervisor-install-dry-run');
      assert.deepStrictEqual(
        body.readinessSummary,
        EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY,
      );
      assert.deepStrictEqual(
        body.installCommandPreview,
        EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
      );
      assert.deepStrictEqual(
        body.installPreflight,
        EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
      );
      assertNoSensitivePreflightEvidence(body.installPreflight);
      assert.strictEqual(body.readinessSummary.state, 'blocked');
      assert.strictEqual(body.safety.launchctlCalled, false);
      assert.strictEqual(body.safety.processListRead, false);
      assert.strictEqual(body.safety.launchdFileWritten, false);
      assert.strictEqual(body.safety.metadataWritten, false);
      assert.strictEqual(body.safety.nasConnected, false);
      assert.strictEqual(body.safety.backupTriggered, false);
      assert.strictEqual(body.safety.restoreTriggered, false);
      assert.strictEqual(body.safety.remoteCommandExecuted, false);
      assert.doesNotMatch(err.stdout, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(err.stdout, /private-source|config\.json|127\.0\.0\.1|3000|Bearer/i);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 2 with only readinessSummary when summary and fail flags are combined', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-fail-summary-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-fail-summary',
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
      }),
    );

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        '--fail-on-blocked',
      ], 2);
      const body = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.deepStrictEqual(body, EXPECTED_SUPERVISOR_INSTALL_READINESS_SUMMARY);
      assert.strictEqual(body.supervisor, undefined);
      assert.strictEqual(body.configSummary, undefined);
      assert.strictEqual(body.installCommandPreview, undefined);
      assert.strictEqual(body.installPreflight, undefined);
      assert.doesNotMatch(err.stdout, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(err.stdout, /private-source|config\.json|127\.0\.0\.1|3000|Bearer/i);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects readiness flags with values before printing JSON', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-flag-values-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-flag-values',
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
      }),
    );

    try {
      const summaryErr = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        'yes',
      ], 1);
      assert.match(summaryErr.stderr, /--readiness-summary does not accept a value/);
      assert.strictEqual(summaryErr.stdout, '');

      const failErr = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--fail-on-blocked',
        'yes',
      ], 1);
      assert.match(failErr.stderr, /--fail-on-blocked does not accept a value/);
      assert.strictEqual(failErr.stdout, '');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('sanitizes config read errors without echoing the config path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-missing-'));
    const missingConfigPath = join(dataDir, 'private-config.json');

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        missingConfigPath,
      ], 1);

      assert.match(err.stderr, /supervisor-install-dry-run failed; verify --config points to a readable valid Linke config/);
      assert.strictEqual(err.stdout, '');
      assert.doesNotMatch(err.stderr, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(err.stderr, /private-config\.json/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('sanitizes validation errors without echoing sensitive config values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-invalid-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'ftp://private-server.local',
        deviceId: 'private-device',
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
        nasTargets: [
          {
            name: 'private-nas',
            provider: 'synology',
            endpoint: 'https://private-nas.local',
            shareName: 'backup',
            remotePath: '/private/remote',
            credentialRef: 'private-ref',
          },
        ],
      }),
    );

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
      ], 1);

      assert.match(err.stderr, /supervisor-install-dry-run failed; verify --config points to a readable valid Linke config/);
      assert.strictEqual(err.stdout, '');
      assert.doesNotMatch(err.stderr, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(err.stderr, /private-server|private-source|private-device|private-nas|private\/remote|private-ref/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects --output and does not create a plist file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-output-'));
    const sourceDir = join(dataDir, 'src');
    const configPath = join(dataDir, 'config.json');
    const outputPath = join(dataDir, 'planned.plist');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-output',
        backupJobs: [{ name: 'docs', sourcePath: sourceDir }],
      }),
    );

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--output',
        outputPath,
      ], 1);

      assert.match(err.stderr, /--output is not supported by supervisor-install-dry-run/);
      assert.strictEqual(err.stdout, '');
      assert.strictEqual(await pathExists(outputPath), false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
