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
 *   --config <path>      Config file path (run-once, launchd-dry-run, supervisor-install-dry-run, nas-dry-run)
 *   --output <path>      Output path (launchd-dry-run)
 *   --keep-last <n>      Number of snapshots to keep (retention-dry-run, default: 3)
 *   --limit <n>          Limit read-only audit-log events
 *   --expected-version <version> Expected release version (release-readiness)
 *   --readiness-summary  Print only readinessSummary for nas-dry-run or supervisor-install-dry-run
 *   --fail-on-blocked   Exit 2 when nas-dry-run/supervisor-install-dry-run readinessSummary.state or gold-readiness status is blocked
 *   --token <token>      Bearer token for authenticated Linke Server requests
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadConfig, validateConfig } from './config.js';
import { runNasDryRunFromConfig } from './nas.js';
import { buildReleaseReadinessReport } from './release-readiness.js';
import { LINKE_RELEASE_VERSION } from './version.js';

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
  --config <path>      Config file path (for run-once, launchd-dry-run, supervisor-install-dry-run, nas-dry-run)
  --output <path>      Output path (for launchd-dry-run, project dir only)
  --keep-last <n>      Snapshots to keep (for retention-dry-run, default: 3)
  --limit <n>          Limit read-only audit-log events
  --expected-version <version> Expected release version (for release-readiness)
  --readiness-summary  Print only readinessSummary for nas-dry-run or supervisor-install-dry-run
  --fail-on-blocked   Exit 2 when nas-dry-run/supervisor-install-dry-run readinessSummary.state or gold-readiness status is blocked
  --token <token>      Bearer token for authenticated Linke Server requests
`);
}

// ── Main ───────────────────────────────────────────────────────────

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const server = args.server || 'http://localhost:3000';
  const requestOptions = args.token && args.token !== true ? { authToken: args.token } : {};
  const apiRequest = (path, method, body) => request(server, path, method, body, requestOptions);

  if (!command) {
    printUsage();
    process.exit(1);
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
