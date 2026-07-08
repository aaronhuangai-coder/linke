#!/usr/bin/env node

/**
 * Linke Agent CLI
 *
 * Commands:
 *   heartbeat           — send heartbeat to server
 *   backup              — backup source path to server
 *   backup-preflight-dry-run — preview backup file selection without creating a snapshot
 *   restore             — restore snapshot to target path
 *   restore-dry-run     — preview restore plan without copying files
 *   snapshots           — list snapshots for a device
 *   status              — show device status
 *   run-once            — run backup once using config file
 *   launchd-dry-run     — generate launchd plist without installing
 *   nas-dry-run         — show NAS dry-run plan (no network, no write)
 *   retention-dry-run   — show retention dry-run plan (no delete, read-only)
 *   health              — check release health status
 *   auth-status         — show sanitized auth status
 *   hardening-status    — show sanitized hardening status
 *   supervisor-status   — show sanitized supervisor status
 *   supervisor-install-dry-run — show sanitized supervisor install plan
 *   supervisor-lifecycle-apply — show blocked lifecycle apply plan
 *   supervisor-lifecycle-approval-persistence-preview — preview approval persistence readiness
 *   supervisor-lifecycle-approval-persist — persist sanitized supervisor lifecycle approval records
 *   supervisor-lifecycle-apply-readiness — show sanitized supervisor lifecycle apply readiness preflight
 *   supervisor-lifecycle-executor-readiness — show sanitized supervisor lifecycle executor readiness
 *   supervisor-lifecycle-executor-manifest-readiness — show sanitized executor manifest readiness
 *   audit-log           — show sanitized local audit events
 *   release-readiness   — evaluate release readiness from health status
 *   gold-readiness      — show Gold readiness blocker scorecard
 *
 * Options:
 *   --server <url>       Server URL (default: http://localhost:3000)
 *   --device <id>        Device ID
 *   --source <path>      Source path for backup
 *   --exclude <pattern>  Exclude pattern (repeatable for backup-preflight-dry-run)
 *   --target <path>      Target path for restore
 *   --snapshot <id>      Snapshot ID for restore
 *   --hostname <name>    Hostname for heartbeat
 *   --ip <address>       IP address for heartbeat
 *   --config <path>      Config file path (run-once, launchd-dry-run, supervisor-install-dry-run, nas-dry-run, supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-executor-manifest-readiness)
 *   --output <path>      Output path (launchd-dry-run)
 *   --approval <path>    Approval JSON file path (supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist)
 *   --manifest <path>    Executor manifest JSON file path (supervisor-lifecycle-executor-manifest-readiness)
 *   --data-dir <path>    Data directory for supervisor lifecycle approval persistence, apply readiness, and executor readiness
 *   --keep-last <n>      Number of snapshots to keep (retention-dry-run, default: 3)
 *   --limit <n>          Limit read-only audit-log events
 *   --expected-version <version> Expected release version (release-readiness)
 *   --readiness-summary  Print only readinessSummary for nas-dry-run or supervisor-install-dry-run
 *   --fail-on-blocked   Exit 2 when supported readiness/status output is blocked
 *   --token <token>      Bearer token for authenticated Linke Server requests
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { loadConfig, validateConfig } from './config.js';
import { runNasDryRunFromConfig } from './nas.js';
import { buildReleaseReadinessReport } from './release-readiness.js';
import { LINKE_RELEASE_VERSION } from './version.js';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleExecutorReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from './supervisor-lifecycle.js';
import {
  appendSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
  readSupervisorLifecycleApprovalRecords,
} from './approval-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(join(__dirname, '..'));
const GOLD_READINESS_STATUSES = new Set(['ready', 'partial', 'blocked']);
const SUPERVISOR_FALSE_FIELDS = [
  'installed',
  'managed',
  'launchdConfigured',
  'watchdogConfigured',
  'monitoringConfigured',
  'recoveryConfigured',
];
const SUPERVISOR_SAFETY_FALSE_FIELDS = [
  'launchctlCalled',
  'processListRead',
  'supervisorInstalled',
  'metadataWritten',
  'nasConnected',
  'backupTriggered',
  'restoreTriggered',
  'remoteCommandExecuted',
];
const SUPERVISOR_INSTALL_DRY_RUN_CONFIG_ERROR = 'supervisor-install-dry-run failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_APPLY_CONFIG_ERROR = 'supervisor-lifecycle-apply failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_APPROVAL_PERSISTENCE_PREVIEW_CONFIG_ERROR = 'supervisor-lifecycle-approval-persistence-preview failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_APPROVAL_PERSIST_CONFIG_ERROR = 'supervisor-lifecycle-approval-persist failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_APPLY_READINESS_CONFIG_ERROR = 'supervisor-lifecycle-apply-readiness failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_EXECUTOR_READINESS_CONFIG_ERROR = 'supervisor-lifecycle-executor-readiness failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_CONFIG_ERROR = 'supervisor-lifecycle-executor-manifest-readiness failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_MANIFEST_ERROR = 'supervisor-lifecycle-executor-manifest-readiness failed; verify --manifest points to a readable valid executor manifest JSON';
const SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_VALIDATION_ERROR = 'supervisor-lifecycle-executor-manifest-readiness failed; manifest validation did not complete';
const FORBIDDEN_APPROVAL_PATH_SEGMENTS = new Set([
  '.aws',
  '.config',
  '.ssh',
  'credentials',
  'gcloud',
  'secrets',
]);
const SUPERVISOR_INSTALL_READINESS_BLOCKERS = Object.freeze([
  'real-install-not-implemented',
  'launchd-install-blocked',
  'supervisor-start-blocked',
  'production-boundaries-incomplete',
]);
const SUPERVISOR_INSTALL_COMMAND_PREVIEW_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'render-launch-agent-plist',
    description: 'Render a launch agent plist preview with redacted config path.',
    command: 'generate launchd plist preview',
  }),
  Object.freeze({
    id: 'write-launch-agent-plist',
    description: 'Future installer would write a launch agent plist to a user LaunchAgents location.',
    command: 'write launch agent plist to [redacted]',
  }),
  Object.freeze({
    id: 'load-launch-agent',
    description: 'Future installer would ask launchd to load the agent after explicit operator approval.',
    command: 'launchctl bootstrap gui/[redacted] [redacted]',
  }),
  Object.freeze({
    id: 'start-launch-agent',
    description: 'Future installer would start the launch agent after successful load.',
    command: 'launchctl kickstart gui/[redacted]/[redacted]',
  }),
]);

const SUPERVISOR_INSTALL_PREFLIGHT_CHECKS = Object.freeze([
  Object.freeze({
    id: 'installer-implementation',
    label: 'Real installer implementation',
    blockerCode: 'real-install-not-implemented',
    evidence: 'No install command or launchd write path exists in this release.',
  }),
  Object.freeze({
    id: 'launchd-lifecycle',
    label: 'Launchd install/start lifecycle',
    blockerCode: 'launchd-lifecycle-blocked',
    evidence: 'launchctl execution, plist writes, and daemon start remain disabled.',
  }),
  Object.freeze({
    id: 'operator-approval',
    label: 'Explicit operator approval gate',
    blockerCode: 'operator-approval-required',
    evidence: 'No approved write path or production install confirmation flow exists.',
  }),
  Object.freeze({
    id: 'secret-management',
    label: 'Production secret management',
    blockerCode: 'secret-management-incomplete',
    evidence: 'Secret rotation, protected storage, and secret handling are not production-grade.',
  }),
  Object.freeze({
    id: 'monitoring-watchdog',
    label: 'Monitoring and watchdog',
    blockerCode: 'monitoring-watchdog-incomplete',
    evidence: 'No watchdog, health recovery loop, alerting, or managed daemon monitoring is implemented.',
  }),
  Object.freeze({
    id: 'rollback-recovery',
    label: 'Rollback and recovery plan',
    blockerCode: 'rollback-recovery-incomplete',
    evidence: 'No rollback, uninstall, or recovery supervisor lifecycle is implemented.',
  }),
]);

const SUPERVISOR_INSTALL_APPROVAL_MANIFEST_CONTROLS = Object.freeze([
  Object.freeze({
    id: 'explicit-operator-approval',
    blockerCode: 'operator-approval-required',
    evidence: 'Install approval is not collected or persisted.',
  }),
  Object.freeze({
    id: 'rollback-plan',
    blockerCode: 'rollback-plan-missing',
    evidence: 'Rollback steps are not implemented.',
  }),
  Object.freeze({
    id: 'uninstall-plan',
    blockerCode: 'uninstall-plan-missing',
    evidence: 'Uninstall steps are not implemented.',
  }),
  Object.freeze({
    id: 'recovery-supervisor',
    blockerCode: 'recovery-supervisor-missing',
    evidence: 'Recovery supervisor lifecycle is not implemented.',
  }),
]);

const SUPERVISOR_ROLLBACK_UNINSTALL_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'capture-current-state',
    kind: 'rollback',
    blockerCode: 'rollback-state-capture-missing',
    evidence: 'Current supervisor state capture is not implemented.',
  }),
  Object.freeze({
    id: 'unload-launch-agent',
    kind: 'uninstall',
    blockerCode: 'launchd-unload-blocked',
    evidence: 'Launch agent unload behavior is not implemented.',
  }),
  Object.freeze({
    id: 'remove-launch-agent-plist',
    kind: 'uninstall',
    blockerCode: 'launchd-remove-blocked',
    evidence: 'Launch agent plist removal is not implemented.',
  }),
  Object.freeze({
    id: 'restore-previous-plist',
    kind: 'rollback',
    blockerCode: 'previous-plist-unavailable',
    evidence: 'Previous plist restore data is not captured.',
  }),
  Object.freeze({
    id: 'start-recovery-supervisor',
    kind: 'recovery',
    blockerCode: 'recovery-supervisor-missing',
    evidence: 'Recovery supervisor start behavior is not implemented.',
  }),
]);

// ── HTTP helper ────────────────────────────────────────────────────

async function request(server, path, method, body, options = {}) {
  const url = `${server}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (options.authToken) opts.headers.Authorization = `Bearer ${options.authToken}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function validateGoldReadinessReport(report) {
  if (!report || typeof report !== 'object' || !GOLD_READINESS_STATUSES.has(report.status)) {
    throw new Error('gold-readiness response has invalid status');
  }
  return report;
}

function isForbiddenApprovalPath(filePath) {
  const normalized = resolve(filePath);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  const basename = segments.at(-1)?.toLowerCase() || '';
  if (basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.env')) {
    return true;
  }
  return segments.some((segment) => FORBIDDEN_APPROVAL_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function hasOnlyFalseBooleans(obj, fields) {
  return fields.every((field) => obj?.[field] === false);
}

function validateSupervisorStatusResponse(report) {
  if (
    !report ||
    typeof report !== 'object' ||
    report.status !== 'partial' ||
    report.service !== 'linke' ||
    typeof report.version !== 'string' ||
    report.supervisor?.state !== 'not_configured' ||
    !hasOnlyFalseBooleans(report.supervisor, SUPERVISOR_FALSE_FIELDS) ||
    !hasOnlyFalseBooleans(report.safety, SUPERVISOR_SAFETY_FALSE_FIELDS)
  ) {
    throw new Error('supervisor-status response has invalid schema');
  }
  return report;
}

// ── Arg parsing ────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (Object.hasOwn(args, key)) {
        if (Array.isArray(args[key])) args[key].push(val);
        else args[key] = [args[key], val];
      } else {
        args[key] = val;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

// ── run-once ───────────────────────────────────────────────────────

/**
 * Load config from `configPath`, validate, then POST /api/backups for each job.
 * Returns an array of snapshot records.
 */
export async function runOnceFromConfig(configPath, options = {}) {
  const raw = await loadConfig(configPath);
  const config = validateConfig(raw);

  // Heartbeat first — marks device online before any backup work
  await request(config.serverUrl, '/api/heartbeat', 'POST', {
    deviceId: config.deviceId,
    hostname: config.hostname,
    ipAddress: config.ipAddress,
  }, options);

  const results = [];
  for (const job of config.backupJobs) {
    const body = {
      deviceId: config.deviceId,
      hostname: config.hostname,
      ipAddress: config.ipAddress,
      sourcePath: job.sourcePath,
      excludePatterns: config.excludePatterns,
      jobName: job.name,
    };
    const result = await request(config.serverUrl, '/api/backups', 'POST', body, options);
    results.push(result);
  }
  return results;
}

// ── launchd dry-run ────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate a launchd plist XML string.
 * @param {object} config  — validated config object
 * @param {string} configPath — path to the config file (embedded in ProgramArguments)
 */
export function generateLaunchdPlist(config, configPath) {
  const label = config.launchdLabel || `com.linke.agent.${config.deviceId}`;
  const interval = config.scheduleSeconds || 3600;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${xmlEscape(label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    '\t\t<string>/usr/bin/env</string>',
    '\t\t<string>node</string>',
    `\t\t<string>${xmlEscape(__filename)}</string>`,
    '\t\t<string>run-once</string>',
    '\t\t<string>--config</string>',
    `\t\t<string>${xmlEscape(resolve(configPath))}</string>`,
    '\t</array>',
    '\t<key>StartInterval</key>',
    `\t<integer>${interval}</integer>`,
    '</dict>',
    '</plist>',
  ].join('\n');
}

/**
 * Validate that `outputPath` resolves inside the project directory.
 * Rejects ~/Library/LaunchAgents, absolute external paths, and ../ escapes.
 */
export function validateOutputPath(outputPath) {
  const resolved = resolve(outputPath);
  if (!resolved.startsWith(PROJECT_ROOT + '/') && resolved !== PROJECT_ROOT) {
    throw new Error(`Output path must be within project directory: ${PROJECT_ROOT}`);
  }
  return resolved;
}

/**
 * Generate plist and optionally write it to `outputPath`.
 * - If outputPath is falsy, returns the plist string (for stdout).
 * - If outputPath is given, validates it, writes, and returns { written, path, content }.
 */
export async function writeLaunchdDryRun(configPath, outputPath) {
  if (outputPath) {
    validateOutputPath(outputPath);
  }

  const raw = await loadConfig(configPath);
  const config = validateConfig(raw);
  const plist = generateLaunchdPlist(config, configPath);

  if (outputPath) {
    const resolved = validateOutputPath(outputPath);
    await writeFile(resolved, plist, 'utf-8');
    return { written: true, path: resolved, content: plist };
  }

  return plist;
}

export function buildSupervisorInstallDryRunPlan(config) {
  const safeConfig = config && typeof config === 'object' ? config : {};
  const backupJobs = Array.isArray(safeConfig.backupJobs) ? safeConfig.backupJobs : [];
  const nasTargets = Array.isArray(safeConfig.nasTargets) ? safeConfig.nasTargets : [];
  const excludePatterns = Array.isArray(safeConfig.excludePatterns) ? safeConfig.excludePatterns : [];

  return {
    status: 'partial',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    command: 'supervisor-install-dry-run',
    supervisor: {
      state: 'not_configured',
      installPlan: 'dry_run_only',
      label: String(safeConfig.launchdLabel || `com.linke.agent.${safeConfig.deviceId || 'unknown'}`),
      scheduleSeconds: Number.isInteger(safeConfig.scheduleSeconds) && safeConfig.scheduleSeconds > 0
        ? safeConfig.scheduleSeconds
        : 3600,
      target: 'user-launch-agent',
      program: 'node src/agent.js run-once --config [redacted]',
      wouldInstall: false,
      wouldStart: false,
      wouldCallLaunchctl: false,
      wouldWriteLaunchAgent: false,
      wouldWriteMetadata: false,
    },
    configSummary: {
      deviceId: String(safeConfig.deviceId || 'unknown'),
      backupJobCount: backupJobs.length,
      nasTargetCount: nasTargets.length,
      excludePatternCount: excludePatterns.length,
    },
    safety: {
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
    },
    readinessSummary: buildSupervisorInstallReadinessSummary(),
    installCommandPreview: buildSupervisorInstallCommandPreview(),
    installPreflight: buildSupervisorInstallPreflight(),
    installApprovalManifest: buildSupervisorInstallApprovalManifest(),
    rollbackUninstallPlan: buildSupervisorRollbackUninstallPlan(),
    nextSteps: [
      'Review this sanitized dry-run plan.',
      'Use launchd-dry-run separately if a plist preview is needed.',
      'Real install/start remains out of scope.',
    ],
  };
}

export function buildSupervisorInstallCommandPreview() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    actions: SUPERVISOR_INSTALL_COMMAND_PREVIEW_ACTIONS.map((action) => ({
      ...action,
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    })),
    safety: {
      executableResolved: false,
      configPathResolved: false,
      plistPathResolved: false,
      launchctlCommandsRunnable: false,
      launchctlCalled: false,
      launchdFileWritten: false,
      metadataWritten: false,
    },
  };
}

export function buildSupervisorInstallPreflight() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    blockedCount: SUPERVISOR_INSTALL_PREFLIGHT_CHECKS.length,
    readyCount: 0,
    checkedCount: SUPERVISOR_INSTALL_PREFLIGHT_CHECKS.length,
    checks: SUPERVISOR_INSTALL_PREFLIGHT_CHECKS.map((check) => ({
      ...check,
      status: 'blocked',
      requiredForInstall: true,
    })),
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
  };
}

export function buildSupervisorInstallApprovalManifest() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    approval: {
      required: true,
      approved: false,
      source: 'not-collected',
      approverReturned: false,
      timestampReturned: false,
      blockerCode: 'operator-approval-required',
      evidence: 'No operator approval workflow or durable approval record exists in this release.',
    },
    rollback: {
      required: true,
      available: false,
      uninstallSupported: false,
      recoverySupervisorSupported: false,
      previousPlistRestoreSupported: false,
      blockerCode: 'rollback-recovery-incomplete',
      evidence: 'No uninstall, rollback, previous plist restore, or recovery supervisor lifecycle exists in this release.',
    },
    controls: SUPERVISOR_INSTALL_APPROVAL_MANIFEST_CONTROLS.map((control) => ({
      ...control,
      status: 'blocked',
      requiredForInstall: true,
    })),
    safety: {
      dryRun: true,
      manifestOnly: true,
      approvalCollected: false,
      approvalPersisted: false,
      rollbackExecuted: false,
      uninstallExecuted: false,
      recoverySupervisorStarted: false,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      supervisorInstalled: false,
      supervisorStarted: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false,
    },
  };
}

export function buildSupervisorRollbackUninstallPlan() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    rollback: {
      requiredBeforeInstall: true,
      available: false,
      previousPlistAvailable: false,
      wouldRestorePreviousPlist: false,
      wouldRestartPreviousSupervisor: false,
      blockerCode: 'rollback-not-implemented',
      evidence: 'Rollback state capture, previous plist restore, and supervisor restart are not implemented.',
    },
    uninstall: {
      requiredBeforeInstall: true,
      available: false,
      wouldUnloadLaunchAgent: false,
      wouldRemoveLaunchAgent: false,
      wouldRemoveMetadata: false,
      blockerCode: 'uninstall-not-implemented',
      evidence: 'Launch agent unload, plist removal, and supervisor metadata removal are not implemented.',
    },
    recovery: {
      requiredBeforeInstall: true,
      available: false,
      supervisorAvailable: false,
      wouldStartRecoverySupervisor: false,
      blockerCode: 'recovery-supervisor-not-implemented',
      evidence: 'Recovery supervisor lifecycle is not implemented.',
    },
    actions: SUPERVISOR_ROLLBACK_UNINSTALL_ACTIONS.map((action) => ({
      ...action,
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    })),
    safety: {
      dryRun: true,
      planOnly: true,
      rollbackExecuted: false,
      uninstallExecuted: false,
      recoverySupervisorStarted: false,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      supervisorInstalled: false,
      supervisorStarted: false,
      launchdFileWritten: false,
      launchdFileRemoved: false,
      previousPlistRestored: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false,
    },
  };
}

export function buildSupervisorInstallReadinessSummary() {
  return {
    state: 'blocked',
    blockedCount: SUPERVISOR_INSTALL_READINESS_BLOCKERS.length,
    blockers: SUPERVISOR_INSTALL_READINESS_BLOCKERS.slice(),
    readyCount: 0,
    checkedCount: SUPERVISOR_INSTALL_READINESS_BLOCKERS.length,
    failOnBlockedExitCode: 2,
  };
}

export async function runSupervisorInstallDryRun(configPath) {
  try {
    const raw = await loadConfig(configPath);
    const config = validateConfig(raw);
    return buildSupervisorInstallDryRunPlan(config);
  } catch {
    throw new Error(SUPERVISOR_INSTALL_DRY_RUN_CONFIG_ERROR);
  }
}

// ── Usage ──────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Linke Agent CLI

Usage:
  node agent.js <command> [options]

Commands:
  heartbeat           Send heartbeat
  backup              Backup files
  backup-preflight-dry-run Preview backup file selection (dry-run, no snapshot)
  restore             Restore from snapshot
  restore-dry-run     Preview restore plan (dry-run, no copy, no overwrite)
  snapshots           List snapshots
  status              Show device status
  run-once            Run backup once using config file
  launchd-dry-run     Generate launchd plist (dry-run, no install)
  nas-dry-run         Show NAS dry-run plan (no network, no write)
  retention-dry-run   Show retention dry-run plan (no delete, read-only)
  health              Check release health status
  auth-status         Show sanitized auth status
  hardening-status    Show sanitized hardening status
  supervisor-status   Show sanitized supervisor status
  supervisor-install-dry-run Show sanitized supervisor install dry-run plan
  supervisor-lifecycle-apply Apply supervisor lifecycle operations under LINKE_SUPERVISOR_LIFECYCLE_APPLY=enabled gate
  supervisor-lifecycle-approval-persistence-preview Preview sanitized approval persistence readiness without writing approval data
  supervisor-lifecycle-approval-persist Persist sanitized supervisor lifecycle approval records
  supervisor-lifecycle-apply-readiness Show sanitized supervisor lifecycle apply readiness preflight
  supervisor-lifecycle-executor-readiness Show sanitized supervisor lifecycle executor readiness
  supervisor-lifecycle-executor-manifest-readiness Show sanitized supervisor lifecycle executor manifest readiness
  audit-log           Show sanitized local audit events
  release-readiness   Evaluate release readiness from health status
  gold-readiness      Show Gold readiness blocker scorecard

Options:
  --server <url>       Server URL (default: http://localhost:3000)
  --device <id>        Device ID
  --source <path>      Source path (for backup)
  --exclude <pattern>  Exclude pattern (repeatable for backup-preflight-dry-run)
  --target <path>      Target path (for restore)
  --snapshot <id>      Snapshot ID (for restore)
  --hostname <name>    Hostname
  --ip <address>       IP address
  --config <path>      Config file path (for run-once, launchd-dry-run, supervisor-install-dry-run, nas-dry-run, supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-executor-manifest-readiness)
  --output <path>      Output path (for launchd-dry-run, project dir only)
  --keep-last <n>      Snapshots to keep (for retention-dry-run, default: 3)
  --limit <n>          Limit read-only audit-log events
  --expected-version <version> Expected release version (for release-readiness)
  --readiness-summary  Print only readinessSummary for nas-dry-run or supervisor-install-dry-run
  --fail-on-blocked   Exit 2 when supported readiness/status output is blocked
  --token <token>      Bearer token for authenticated Linke Server requests
  --approval <path>    Approval JSON file path (for supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist)
  --manifest <path>    Executor manifest JSON file path (for supervisor-lifecycle-executor-manifest-readiness)
  --data-dir <path>    Data directory (for supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness)
`);
}

// ── Main ───────────────────────────────────────────────────────────

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const server = args.server || 'http://localhost:3000';
  const requestOptions = args.token && args.token !== true ? { authToken: args.token } : {};
  const apiRequest = (path, method, body) => request(server, path, method, body, requestOptions);

  if (!command || args.help || args.h || command === 'help') {
    printUsage();
    process.exit(args.help || args.h || command === 'help' ? 0 : 1);
  }

  try {
    if (args.token === true) {
      throw new Error('--token requires a value');
    }

    switch (command) {
      case 'heartbeat': {
        if (!args.device) throw new Error('--device is required');
        const result = await apiRequest('/api/heartbeat', 'POST', {
          deviceId: args.device,
          hostname: args.hostname,
          ipAddress: args.ip,
        });
        console.log('Heartbeat recorded:');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'backup': {
        if (!args.device || !args.source) throw new Error('--device and --source are required');
        const result = await apiRequest('/api/backups', 'POST', {
          deviceId: args.device,
          hostname: args.hostname,
          ipAddress: args.ip,
          sourcePath: args.source,
        });
        console.log('Backup created:');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'backup-preflight-dry-run': {
        if (!args.source) throw new Error('--source is required');
        const params = new URLSearchParams({ sourcePath: args.source });
        const excludeValues = args.exclude === undefined
          ? []
          : (Array.isArray(args.exclude) ? args.exclude : [args.exclude]);
        for (const pattern of excludeValues) {
          if (pattern === true) throw new Error('--exclude requires a pattern value');
          params.append('exclude', pattern);
        }
        const plan = await apiRequest(`/api/backup-preflight-dry-run?${params.toString()}`, 'GET');
        console.log(JSON.stringify(plan, null, 2));
        break;
      }

      case 'restore': {
        if (!args.device || !args.snapshot || !args.target) {
          throw new Error('--device, --snapshot, and --target are required');
        }
        const result = await apiRequest('/api/restore', 'POST', {
          deviceId: args.device,
          snapshotId: args.snapshot,
          targetPath: args.target,
        });
        console.log('Restore completed:');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'restore-dry-run': {
        if (!args.device || !args.snapshot || !args.target) {
          throw new Error('--device, --snapshot, and --target are required');
        }
        const path = `/api/devices/${encodeURIComponent(args.device)}`
          + `/snapshots/${encodeURIComponent(args.snapshot)}`
          + `/restore-dry-run?targetPath=${encodeURIComponent(args.target)}`;
        const plan = await apiRequest(path, 'GET');
        console.log(JSON.stringify(plan, null, 2));
        break;
      }

      case 'snapshots': {
        if (!args.device) throw new Error('--device is required');
        const result = await apiRequest(`/api/devices/${encodeURIComponent(args.device)}/snapshots`, 'GET');
        console.log('Snapshots:');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'status': {
        if (!args.device) throw new Error('--device is required');
        const devices = await apiRequest('/api/devices', 'GET');
        const device = devices.find((d) => d.deviceId === args.device);
        if (!device) {
          console.log(`Device "${args.device}" not found`);
          process.exit(1);
        }
        console.log('Device status:');
        console.log(JSON.stringify(device, null, 2));
        break;
      }

      case 'run-once': {
        if (!args.config) throw new Error('--config is required');
        const results = await runOnceFromConfig(args.config, requestOptions);
        console.log('Run-once completed:');
        console.log(JSON.stringify(results, null, 2));
        break;
      }

      case 'launchd-dry-run': {
        if (!args.config) throw new Error('--config is required');
        const result = await writeLaunchdDryRun(args.config, args.output);
        if (typeof result === 'string') {
          console.log(result);
        } else {
          console.log(`Plist written to: ${result.path}`);
        }
        break;
      }

      case 'nas-dry-run': {
        if (!args.config) throw new Error('--config is required');
        if (args['readiness-summary'] !== undefined && args['readiness-summary'] !== true) {
          throw new Error('--readiness-summary does not accept a value');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }
        const plan = await runNasDryRunFromConfig(args.config);
        const needsReadinessSummary = args['readiness-summary'] === true || args['fail-on-blocked'] === true;
        const readinessSummary = plan.readinessSummary;
        if (needsReadinessSummary && !readinessSummary) {
          throw new Error('readinessSummary missing from dry-run plan');
        }
        let output = plan;
        if (args['readiness-summary'] === true) {
          output = readinessSummary;
        }
        console.log(JSON.stringify(output, null, 2));
        if (args['fail-on-blocked'] === true && readinessSummary.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'retention-dry-run': {
        if (!args.device) throw new Error('--device is required');

        // Validate --keep-last: must be a positive integer if provided
        let keepLast;
        const keepLastRaw = args['keep-last'];
        if (keepLastRaw !== undefined) {
          // Reject boolean true (flag without value)
          if (keepLastRaw === true) {
            throw new Error('--keep-last requires a positive integer value');
          }
          // Must be a string that represents a positive integer
          if (typeof keepLastRaw !== 'string' || !/^\d+$/.test(keepLastRaw)) {
            throw new Error('--keep-last must be a positive integer');
          }
          const parsed = Number(keepLastRaw);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new Error('--keep-last must be a positive integer');
          }
          keepLast = parsed;
        }

        let path = `/api/devices/${encodeURIComponent(args.device)}/retention-dry-run`;
        if (keepLast !== undefined) {
          path += `?keepLast=${keepLast}`;
        }
        const plan = await apiRequest(path, 'GET');
        console.log(JSON.stringify(plan, null, 2));
        break;
      }

      case 'health': {
        const result = await apiRequest('/api/health', 'GET');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'auth-status': {
        const result = await apiRequest('/api/auth-status', 'GET');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'hardening-status': {
        const result = await apiRequest('/api/hardening-status', 'GET');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'supervisor-status': {
        const result = validateSupervisorStatusResponse(await apiRequest('/api/supervisor-status', 'GET'));
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'supervisor-install-dry-run': {
        if (!args.config) throw new Error('--config is required');
        if (args.output !== undefined) {
          throw new Error('--output is not supported by supervisor-install-dry-run');
        }
        if (args['readiness-summary'] !== undefined && args['readiness-summary'] !== true) {
          throw new Error('--readiness-summary does not accept a value');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }
        const result = await runSupervisorInstallDryRun(args.config);
        const output = args['readiness-summary'] === true ? result.readinessSummary : result;
        console.log(JSON.stringify(output, null, 2));
        if (args['fail-on-blocked'] === true && result.readinessSummary.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'audit-log': {
        const limitRaw = args.limit;
        let path = '/api/audit-log';
        if (limitRaw !== undefined) {
          if (limitRaw === true) {
            throw new Error('--limit requires a positive integer value');
          }
          if (typeof limitRaw !== 'string' || !/^\d+$/.test(limitRaw) || Number(limitRaw) <= 0) {
            throw new Error('--limit must be a positive integer');
          }
          path += `?limit=${encodeURIComponent(limitRaw)}`;
        }
        const result = await apiRequest(path, 'GET');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'release-readiness': {
        if (args['expected-version'] === true) {
          throw new Error('--expected-version requires a value');
        }
        const health = await apiRequest('/api/health', 'GET');
        const report = buildReleaseReadinessReport(health, {
          expectedVersion: args['expected-version'] || undefined,
        });
        console.log(JSON.stringify(report, null, 2));
        if (!report.ready) {
          process.exitCode = 2;
        }
        break;
      }

      case 'gold-readiness': {
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }
        const report = validateGoldReadinessReport(await apiRequest('/api/gold-readiness', 'GET'));
        console.log(JSON.stringify(report, null, 2));
        if (args['fail-on-blocked'] === true && report?.status === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-approval-persistence-preview': {
        if (!args.config) {
          throw new Error('--config is required');
        }
        if (args.config === true) {
          throw new Error('--config requires a path value');
        }
        if (!args.operation) {
          throw new Error('--operation is required');
        }
        if (args.operation === true) {
          throw new Error('--operation requires a value');
        }
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(args.operation)) {
          throw new Error('operation must be one of: install, uninstall, rollback, recover');
        }
        if (args.apply !== undefined) {
          throw new Error('--apply is not supported for supervisor-lifecycle-approval-persistence-preview');
        }
        if (args.approval === true) {
          throw new Error('--approval requires a path value');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_APPROVAL_PERSISTENCE_PREVIEW_CONFIG_ERROR);
        }

        let approval = null;
        if (args.approval) {
          if (isForbiddenApprovalPath(args.approval)) {
            throw new Error('approval path is not allowed');
          }
          try {
            const rawApproval = await readFile(args.approval, 'utf-8');
            approval = JSON.parse(rawApproval);
          } catch (err) {
            throw new Error('failed to read or parse approval file');
          }
        }

        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
          approval,
        });
        const preview = buildSupervisorLifecycleApprovalPersistencePreview(lifecyclePlan, approval);

        console.log(JSON.stringify(preview, null, 2));

        if (args['fail-on-blocked'] === true && preview.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-approval-persist': {
        if (!args.config) {
          throw new Error('--config is required');
        }
        if (args.config === true) {
          throw new Error('--config requires a path value');
        }
        if (!args.operation) {
          throw new Error('--operation is required');
        }
        if (args.operation === true) {
          throw new Error('--operation requires a value');
        }
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(args.operation)) {
          throw new Error('operation must be one of: install, uninstall, rollback, recover');
        }
        if (!args.approval) {
          throw new Error('--approval is required');
        }
        if (args.approval === true) {
          throw new Error('--approval requires a path value');
        }
        if (!args['data-dir']) {
          throw new Error('--data-dir is required');
        }
        if (args['data-dir'] === true) {
          throw new Error('--data-dir requires a path value');
        }
        if (args.apply !== undefined) {
          throw new Error('--apply is not supported');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_APPROVAL_PERSIST_CONFIG_ERROR);
        }

        if (isForbiddenApprovalPath(args.approval)) {
          throw new Error('approval path is not allowed');
        }
        let approval;
        try {
          const rawApproval = await readFile(args.approval, 'utf-8');
          approval = JSON.parse(rawApproval);
        } catch (err) {
          throw new Error('failed to read or parse approval file');
        }

        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
          approval,
        });
        const preview = buildSupervisorLifecycleApprovalPersistencePreview(lifecyclePlan, approval);

        const persistable = isPersistablePreview(preview);

        if (!persistable) {
          console.log(JSON.stringify(preview, null, 2));
          process.exitCode = 2;
        } else {
          let record;
          try {
            record = await appendSupervisorLifecycleApprovalRecord(args['data-dir'], preview, approval);
          } catch (err) {
            throw new Error('failed to persist approval record');
          }
          console.log(JSON.stringify(record, null, 2));
        }
        break;
      }

      case 'supervisor-lifecycle-apply': {
        if (!args.config) {
          throw new Error('--config is required');
        }
        if (args.config === true) {
          throw new Error('--config requires a path value');
        }
        if (!args.operation) {
          throw new Error('--operation is required');
        }
        if (args.operation === true) {
          throw new Error('--operation requires a value');
        }
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(args.operation)) {
          throw new Error('operation must be one of: install, uninstall, rollback, recover');
        }
        if (args.apply !== undefined && args.apply !== true) {
          throw new Error('--apply does not accept a value');
        }
        if (args.approval === true) {
          throw new Error('--approval requires a path value');
        }
        if (args['launchd-dir'] === true) {
          throw new Error('--launchd-dir requires a path value');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_APPLY_CONFIG_ERROR);
        }

        let approval = null;
        if (args.approval) {
          if (isForbiddenApprovalPath(args.approval)) {
            throw new Error('approval path is not allowed');
          }
          try {
            const rawApproval = await readFile(args.approval, 'utf-8');
            approval = JSON.parse(rawApproval);
          } catch (err) {
            throw new Error('failed to read or parse approval file');
          }
        }

        const envGateEnabled = process.env.LINKE_SUPERVISOR_LIFECYCLE_APPLY === 'enabled';

        const plan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: args.apply === true,
          envGateEnabled,
          approval,
          launchdDir: args['launchd-dir'] || undefined,
        });

        console.log(JSON.stringify(plan, null, 2));

        if (args.apply === true) {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-apply-readiness': {
        if (!args.config) {
          throw new Error('--config is required');
        }
        if (args.config === true) {
          throw new Error('--config requires a path value');
        }
        if (!args.operation) {
          throw new Error('--operation is required');
        }
        if (args.operation === true) {
          throw new Error('--operation requires a value');
        }
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(args.operation)) {
          throw new Error('operation must be one of: install, uninstall, rollback, recover');
        }
        if (!args['data-dir']) {
          throw new Error('--data-dir is required');
        }
        if (args['data-dir'] === true) {
          throw new Error('--data-dir requires a path value');
        }
        if (args.apply !== undefined) {
          throw new Error('--apply is not supported');
        }
        if (args.approval !== undefined) {
          throw new Error('--approval is not supported');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_APPLY_READINESS_CONFIG_ERROR);
        }

        let approvalRecords;
        try {
          approvalRecords = await readSupervisorLifecycleApprovalRecords(args['data-dir']);
        } catch (err) {
          throw new Error('failed to read supervisor lifecycle approval records');
        }

        const plan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
        });

        const readiness = buildSupervisorLifecycleApplyReadiness(plan, approvalRecords);

        console.log(JSON.stringify(readiness, null, 2));

        if (args['fail-on-blocked'] === true && readiness.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-executor-readiness': {
        if (!args.config) {
          throw new Error('--config is required');
        }
        if (args.config === true) {
          throw new Error('--config requires a path value');
        }
        if (!args.operation) {
          throw new Error('--operation is required');
        }
        if (args.operation === true) {
          throw new Error('--operation requires a value');
        }
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(args.operation)) {
          throw new Error('operation must be one of: install, uninstall, rollback, recover');
        }
        if (!args['data-dir']) {
          throw new Error('--data-dir is required');
        }
        if (args['data-dir'] === true) {
          throw new Error('--data-dir requires a path value');
        }
        if (args.apply !== undefined) {
          throw new Error('--apply is not supported');
        }
        if (args.approval !== undefined) {
          throw new Error('--approval is not supported');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_EXECUTOR_READINESS_CONFIG_ERROR);
        }

        let approvalRecords;
        try {
          approvalRecords = await readSupervisorLifecycleApprovalRecords(args['data-dir']);
        } catch (err) {
          throw new Error('failed to read supervisor lifecycle approval records');
        }

        const plan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
        });

        const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, approvalRecords);
        const executorReadiness = buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness);

        console.log(JSON.stringify(executorReadiness, null, 2));

        if (args['fail-on-blocked'] === true && executorReadiness.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-executor-manifest-readiness': {
        if (!args.config) {
          throw new Error('--config is required');
        }
        if (args.config === true) {
          throw new Error('--config requires a path value');
        }
        if (!args.operation) {
          throw new Error('--operation is required');
        }
        if (args.operation === true) {
          throw new Error('--operation requires a value');
        }
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(args.operation)) {
          throw new Error('operation must be one of: install, uninstall, rollback, recover');
        }
        if (!args.manifest) {
          throw new Error('--manifest is required');
        }
        if (args.manifest === true) {
          throw new Error('--manifest requires a path value');
        }
        if (args.apply !== undefined) {
          throw new Error('--apply is not supported');
        }
        if (args.approval !== undefined) {
          throw new Error('--approval is not supported');
        }
        if (args['data-dir'] !== undefined) {
          throw new Error('--data-dir is not supported');
        }
        if (args.output !== undefined) {
          throw new Error('--output is not supported');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_CONFIG_ERROR);
        }

        let manifest;
        try {
          const rawManifest = await readFile(args.manifest, 'utf-8');
          manifest = JSON.parse(rawManifest);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_MANIFEST_ERROR);
        }

        const plan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
        });

        let manifestReadiness;
        try {
          manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, manifest);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_VALIDATION_ERROR);
        }

        console.log(JSON.stringify(manifestReadiness, null, 2));

        if (args['fail-on-blocked'] === true && manifestReadiness.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Only auto-start when executed directly (not when imported by tests)
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
