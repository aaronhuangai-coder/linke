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
 *   nas-snapshot-replicate — plan/execute/recover mounted SMB snapshot replication
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
 *   supervisor-lifecycle-guarded-runner-readiness — show sanitized guarded runner binding readiness
 *   supervisor-lifecycle-guarded-runner-execution-preview — show sanitized guarded runner execution preview
 *   supervisor-lifecycle-guarded-runner-execution-gate — show sanitized guarded runner execution gate
 *   audit-log           — show sanitized local audit events
 *   audit-integrity-monitor — run-once local audit integrity monitor (JSON on stdout; no network; no write)
 *   audit-integrity-rotate — explicitly rotate the local audit integrity generation
 *   audit-integrity-rotation-recover — explicitly recover a local audit integrity rotation
 *   release-readiness   — evaluate release readiness from health status
 *   gold-readiness      — show Gold readiness blocker scorecard
 *   device-enroll       — enroll device via certificate-pinned Agent HTTPS (code from stdin)
 *   device-heartbeat    — authenticated device heartbeat (token from Keychain only)
 *   device-token-rotate — rotate device token (token from Keychain only)
 *   management-auth-rotate — rotate management auth Keychain token under cross-process lock
 *
 * Options:
 *   --server <url>       Server URL (default: http://localhost:3000); device-* require HTTPS Agent URL
 *   --device <id>        Device ID
 *   --source <path>      Source path for backup
 *   --exclude <pattern>  Exclude pattern (repeatable for backup-preflight-dry-run)
 *   --target <path>      Target path for restore
 *   --snapshot <id>      Snapshot ID for restore
 *   --hostname <name>    Hostname for heartbeat
 *   --ip <address>       IP address for heartbeat
 *   --config <path>      Config file path (run-once, launchd-dry-run, supervisor-install-dry-run, nas-dry-run, nas-snapshot-replicate, supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-executor-manifest-readiness, supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
 *   --operation <operation> Supervisor lifecycle operation (supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-executor-manifest-readiness, supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
 *   --output <path>      Output path (launchd-dry-run)
 *   --approval <path>    Approval JSON file path (supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist)
 *   --manifest <path>    Executor manifest JSON file path (supervisor-lifecycle-executor-manifest-readiness, supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
 *   --runner-binding <path> Guarded runner binding JSON file path (supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
 *   --data-dir <path>    Data directory for nas-snapshot-replicate, supervisor lifecycle approval persistence, apply readiness, executor readiness, guarded runner execution gate, audit-integrity-monitor, explicit audit integrity rotation/recovery, and management-auth-rotate
 *   --expected-generation-id <hex> Expected audit generation ID (rotate only; 32 lowercase hex)
 *   --expected-head-digest <hex> Expected audit journal head digest (rotate only; 64 lowercase hex)
 *   --target <name>      NAS target name (nas-snapshot-replicate)
 *   --device-id <id>     Device ID for local snapshot lookup (nas-snapshot-replicate)
 *   --snapshot-id <id>   Snapshot ID for local snapshot lookup (nas-snapshot-replicate)
 *   --execute            Enable real mounted SMB replication write path (requires LINKE_NAS_SMB_EXECUTION=enabled)
 *   --recover            Explicit stale attempt recovery (requires --execute)
 *   --execute-requested Record explicit execution intent for the guarded runner execution gate without executing
 *   --keep-last <n>      Number of snapshots to keep (retention-dry-run, default: 3)
 *   --limit <n>          Limit read-only audit-log events
 *   --expected-version <version> Expected release version (release-readiness)
 *   --readiness-summary  Print only readinessSummary for nas-dry-run or supervisor-install-dry-run
 *   --fail-on-blocked   Exit 2 when supported readiness/status output is blocked
 *   --token <token>      Bearer token for authenticated Linke Server management requests (not accepted by device-* commands)
 *   --tls-fingerprint <hex> Admin-confirmed Agent certificate SHA-256 (64 hex; colons optional)
 *   --enrollment-code-stdin Read one-time enrollment code from stdin (required for device-enroll; never via argv)
 *   --scope <read|write> Management auth scope to rotate (management-auth-rotate; reserved fixed flag, not yet accepted)
 *   --token-stdin      Read the new management auth token from stdin (management-auth-rotate; reserved fixed flag, token from stdin only, never via argv)
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
  buildSupervisorLifecycleGuardedRunnerExecutionGate,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from './supervisor-lifecycle.js';
import {
  appendSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
  readSupervisorLifecycleApprovalRecords,
} from './approval-store.js';
import { appendAuditEvent } from './audit-log.js';
import {
  SmbReplicationError,
  buildSmbSnapshotReplicationPlan,
  recoverMountedSmbSnapshot,
  replicateSnapshotToMountedSmb,
} from './smb-snapshot-replication.js';
import { KeychainStore } from './keychain-store.js';
import {
  DeviceCredentialStore,
  enrollDevice,
  heartbeatDevice,
  rotateDeviceToken,
} from './device-client.js';
import {
  runAuditIntegrityMonitor,
  auditIntegrityMonitorExitCode,
  formatAuditIntegrityMonitorReportJson,
} from './audit-integrity-monitor.js';
import {
  recoverAuditIntegrityRotation,
  rotateAuditIntegrityGeneration,
} from './audit-integrity-rotation.js';
import {
  ManagementAuthRotateCommandError,
  runManagementAuthRotateCommand,
} from './management-auth-rotate-command.js';
import { ManagementAuthRotationError } from './management-auth-rotation.js';
import { ManagementAuthRotationProcessLockError } from './management-auth-rotation-process-lock.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const AUDIT_INTEGRITY_MONITOR_COMMAND = 'audit-integrity-monitor';
const AUDIT_INTEGRITY_MONITOR_ARG_KEYS = new Set(['_', 'data-dir']);
const AUDIT_INTEGRITY_MONITOR_ARGS_ERROR = 'audit-integrity-monitor arguments are invalid';
const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'audit-integrity-monitor failed';
const AUDIT_INTEGRITY_ROTATE_COMMAND = 'audit-integrity-rotate';
const AUDIT_INTEGRITY_ROTATION_RECOVER_COMMAND = 'audit-integrity-rotation-recover';
const MANAGEMENT_AUTH_ROTATE_COMMAND = 'management-auth-rotate';
const MANAGEMENT_AUTH_ROTATE_ARGUMENTS_ERROR = 'management-auth-rotate arguments are invalid';
const MANAGEMENT_AUTH_ROTATE_STDIN_ERROR = 'management-auth-rotate stdin is invalid';
const MANAGEMENT_AUTH_ROTATE_REFUSED_ERROR = 'management-auth-rotate refused';
const MANAGEMENT_AUTH_ROTATE_EXECUTION_ERROR = 'management-auth-rotate failed';
const AUDIT_INTEGRITY_ROTATE_ARGS_ERROR =
  'audit-integrity-rotate arguments are invalid';
const AUDIT_INTEGRITY_ROTATE_REFUSED_ERROR = 'audit-integrity-rotate refused';
const AUDIT_INTEGRITY_ROTATE_EXECUTION_ERROR = 'audit-integrity-rotate failed';
const AUDIT_INTEGRITY_ROTATION_RECOVER_ARGS_ERROR =
  'audit-integrity-rotation-recover arguments are invalid';
const AUDIT_INTEGRITY_ROTATION_RECOVER_REFUSED_ERROR =
  'audit-integrity-rotation-recover refused';
const AUDIT_INTEGRITY_ROTATION_RECOVER_EXECUTION_ERROR =
  'audit-integrity-rotation-recover failed';
const AUDIT_INTEGRITY_GENERATION_ID_RE = /^[0-9a-f]{32}$/;
const AUDIT_INTEGRITY_HEAD_DIGEST_RE = /^[0-9a-f]{64}$/;
const AUDIT_INTEGRITY_LOCAL_STRICT_COMMANDS = new Set([
  AUDIT_INTEGRITY_MONITOR_COMMAND,
  AUDIT_INTEGRITY_ROTATE_COMMAND,
  AUDIT_INTEGRITY_ROTATION_RECOVER_COMMAND,
  MANAGEMENT_AUTH_ROTATE_COMMAND,
]);
const AUDIT_INTEGRITY_REFUSAL_CODES = new Set(
  Object.values(ERROR_CODES).filter(
    (code) => typeof code === 'string' && code.startsWith('audit-integrity-'),
  ),
);

/**
 * Local strict argv contract for audit-integrity-monitor only.
 * Does not change global parseArgs semantics.
 * Fail-closed fixed message; never echoes flag/value/path/token.
 *
 * Layer 1: raw argv must be exactly
 *   [ 'audit-integrity-monitor', '--data-dir', <non-empty path not starting with --> ]
 * so prototype-polluting flags (e.g. --__proto__) cannot bypass Object.keys allowlists.
 * Layer 2: parsed args exact keys / positional / string checks.
 *
 * @param {object} args
 * @param {string[]} rawArgv process.argv.slice(2); compared only, never echoed
 */
function assertAuditIntegrityMonitorArgs(args, rawArgv) {
  if (
    !Array.isArray(rawArgv)
    || rawArgv.length !== 3
    || rawArgv[0] !== AUDIT_INTEGRITY_MONITOR_COMMAND
    || rawArgv[1] !== '--data-dir'
    || typeof rawArgv[2] !== 'string'
    || rawArgv[2].trim().length === 0
    || rawArgv[2].startsWith('--')
  ) {
    throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
  }

  const keys = Object.keys(args);
  if (keys.length !== AUDIT_INTEGRITY_MONITOR_ARG_KEYS.size) {
    throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
  }
  for (const key of keys) {
    if (!AUDIT_INTEGRITY_MONITOR_ARG_KEYS.has(key)) {
      throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
    }
  }
  for (const required of AUDIT_INTEGRITY_MONITOR_ARG_KEYS) {
    if (!Object.hasOwn(args, required)) {
      throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
    }
  }
  if (
    !Array.isArray(args._)
    || args._.length !== 1
    || args._[0] !== AUDIT_INTEGRITY_MONITOR_COMMAND
  ) {
    throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
  }
  const dataDir = args['data-dir'];
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
  }
  // raw path token must match the parsed value (no reordering / alias tricks)
  if (rawArgv[2] !== dataDir) {
    throw new Error(AUDIT_INTEGRITY_MONITOR_ARGS_ERROR);
  }
}

/**
 * Parse the exact local audit-integrity-rotate argv surface.
 * Raw positional validation rejects duplicates, aliases, reordered flags,
 * extra tokens, prototype-polluting flags, and flag-like values.
 *
 * @param {string[]} rawArgv process.argv.slice(2); never echoed
 * @returns {Readonly<{
 *   dataDir: string,
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 * }>}
 */
function parseAuditIntegrityRotateArgs(rawArgv) {
  if (
    !Array.isArray(rawArgv)
    || rawArgv.length !== 7
    || rawArgv[0] !== AUDIT_INTEGRITY_ROTATE_COMMAND
    || rawArgv[1] !== '--data-dir'
    || typeof rawArgv[2] !== 'string'
    || rawArgv[2].trim().length === 0
    || rawArgv[2].startsWith('--')
    || rawArgv[3] !== '--expected-generation-id'
    || typeof rawArgv[4] !== 'string'
    || !AUDIT_INTEGRITY_GENERATION_ID_RE.test(rawArgv[4])
    || rawArgv[5] !== '--expected-head-digest'
    || typeof rawArgv[6] !== 'string'
    || !AUDIT_INTEGRITY_HEAD_DIGEST_RE.test(rawArgv[6])
  ) {
    throw new Error(AUDIT_INTEGRITY_ROTATE_ARGS_ERROR);
  }

  return Object.freeze({
    dataDir: rawArgv[2],
    expectedGenerationId: rawArgv[4],
    expectedHeadDigest: rawArgv[6],
  });
}

/**
 * Parse the exact local audit-integrity-rotation-recover argv surface.
 *
 * @param {string[]} rawArgv process.argv.slice(2); never echoed
 * @returns {Readonly<{ dataDir: string }>}
 */
function parseAuditIntegrityRotationRecoverArgs(rawArgv) {
  if (
    !Array.isArray(rawArgv)
    || rawArgv.length !== 3
    || rawArgv[0] !== AUDIT_INTEGRITY_ROTATION_RECOVER_COMMAND
    || rawArgv[1] !== '--data-dir'
    || typeof rawArgv[2] !== 'string'
    || rawArgv[2].trim().length === 0
    || rawArgv[2].startsWith('--')
  ) {
    throw new Error(AUDIT_INTEGRITY_ROTATION_RECOVER_ARGS_ERROR);
  }

  return Object.freeze({ dataDir: rawArgv[2] });
}

/**
 * Only registered audit-integrity error codes are public CLI refusals.
 * Error messages alone never authorize exit 2.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isAuditIntegrityRefusal(error) {
  return Boolean(
    error
    && typeof error === 'object'
    && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
    && AUDIT_INTEGRITY_REFUSAL_CODES.has(
      /** @type {{ code: string }} */ (error).code,
    ),
  );
}

const NAS_REPLICATION_ARG_KEYS = new Set([
  '_',
  'config',
  'data-dir',
  'target',
  'device-id',
  'snapshot-id',
  'execute',
  'recover',
]);

const NAS_REPLICATION_SUCCESS_STATES = new Set([
  'planned',
  'replicated',
  'already_verified',
  'recovered',
]);

/**
 * Reject any CLI key outside the mounted SMB replication allowlist.
 * Fail-closed with a fixed code; never echo parameter names or values.
 */
function assertNasReplicationArgs(args) {
  if (Object.keys(args).some((key) => !NAS_REPLICATION_ARG_KEYS.has(key))) {
    throw new SmbReplicationError('smb-arguments-invalid', 1);
  }
}

/**
 * Require a non-empty string value for a CLI flag.
 * Flag-without-value (`true`) is treated as invalid.
 */
function requireNasReplicationValue(args, key) {
  const value = args[key];
  if (value === undefined || value === true || typeof value !== 'string' || !value.trim()) {
    throw new SmbReplicationError('smb-arguments-invalid', 1);
  }
}

/**
 * Boolean CLI flags must be present as `true` or absent; values are rejected.
 */
function assertNasReplicationBooleanFlag(args, key) {
  if (args[key] !== undefined && args[key] !== true) {
    throw new SmbReplicationError('smb-arguments-invalid', 1);
  }
}

/**
 * Map a successful replication result state to a local audit event type.
 */
function nasReplicationAuditTypeForState(state) {
  switch (state) {
    case 'planned':
      return 'nas.snapshot.replication.planned';
    case 'replicated':
      return 'nas.snapshot.replication.completed';
    case 'already_verified':
      return 'nas.snapshot.replication.already_verified';
    case 'recovered':
      return 'nas.snapshot.replication.recovered';
    default:
      return 'nas.snapshot.replication.failed';
  }
}

/**
 * Best-effort sanitized audit write for NAS snapshot replication.
 * Never throws into the CLI path; audit failure must not change exit semantics.
 */
async function appendNasReplicationAudit(dataDir, event) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) return;
  try {
    await appendAuditEvent(dataDir, event);
  } catch {
    // ignore audit I/O failures
  }
}

/**
 * Required pre-side-effect NAS replication start audit (fail-closed).
 * Calls appendAuditEvent directly — never the best-effort swallow helper.
 * Any append/sanitize/dual-write failure remaps to AUDIT_DELIVERY_UNAVAILABLE.
 * Does not log raw err.message / path / token / stack / errno.
 */
async function recordRequiredNasReplicationStartAudit(dataDir, fields) {
  try {
    await appendAuditEvent(dataDir, {
      type: 'nas.snapshot.replication.started',
      outcome: 'started',
      targetName: fields.targetName,
      deviceId: fields.deviceId,
      snapshotId: fields.snapshotId,
    });
  } catch {
    throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, {
      statusCode: 503,
      retryable: true,
    });
  }
}

/**
 * Build allowlisted audit payload fields from a sanitized replication result.
 */
function nasReplicationAuditFieldsFromResult(result) {
  const fields = {
    outcome: 'success',
    targetName: result.targetName,
    deviceId: result.deviceId,
    snapshotId: result.snapshotId,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
  };
  if (typeof result.attemptId === 'string') fields.attemptId = result.attemptId;
  if (Number.isInteger(result.verifiedFileCount)) fields.verifiedFileCount = result.verifiedFileCount;
  if (Number.isInteger(result.retryCount)) fields.retryCount = result.retryCount;
  if (typeof result.wouldWrite === 'boolean') fields.wouldWrite = result.wouldWrite;
  if (typeof result.executionRequired === 'boolean') fields.executionRequired = result.executionRequired;
  return fields;
}

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
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-readiness failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_MANIFEST_ERROR = 'supervisor-lifecycle-guarded-runner-readiness failed; verify --manifest points to a readable valid executor manifest JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_BINDING_ERROR = 'supervisor-lifecycle-guarded-runner-readiness failed; verify --runner-binding points to a readable valid guarded runner binding JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-readiness failed; guarded runner readiness validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_MANIFEST_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify --manifest points to a readable valid executor manifest JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_BINDING_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify --runner-binding points to a readable valid guarded runner binding JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_MANIFEST_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify --manifest points to a readable valid executor manifest JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_BINDING_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify --runner-binding points to a readable valid guarded runner binding JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete';
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

// ── Device enrollment / token CLI (secrets from stdin / Keychain only) ──

/**
 * Read a single secret line from stdin (or injected stream).
 * Cap 4096 bytes; reject empty, multi-line, and oversized input.
 * @param {AsyncIterable<unknown>} [input=process.stdin]
 * @returns {Promise<string>}
 */
async function readSingleSecretLine(input = process.stdin) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 4_096) throw new Error('stdin secret is invalid');
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new Error('stdin secret is invalid');
  }
  return value;
}

/**
 * Fixed safe CLI error that never echoes argument values.
 * @returns {Error}
 */
function deviceCommandArgsInvalidError() {
  return new Error('device command arguments are invalid');
}

/**
 * Validate public device CLI args before stdin/Keychain/operation access.
 * Requires non-empty string server, device, and tls-fingerprint.
 * @param {unknown} args
 */
function assertDeviceCommandPublicArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw deviceCommandArgsInvalidError();
  }
  const record = /** @type {Record<string, unknown>} */ (args);
  for (const key of ['server', 'device', 'tls-fingerprint']) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw deviceCommandArgsInvalidError();
    }
  }
}

/**
 * Lazy production credential store; only constructed after public arg validation.
 * @returns {DeviceCredentialStore}
 */
function createDefaultDeviceCredentialStore() {
  return new DeviceCredentialStore({ keychain: new KeychainStore() });
}

/**
 * device-enroll: certificate-pinned enrollment; code only from stdin.
 * Public args validated before stdin read, Keychain construction, or enroll.
 * @param {Record<string, unknown>} args
 * @param {{
 *   input?: AsyncIterable<unknown>,
 *   credentialStore?: { getToken: Function, setToken: Function },
 *   enroll?: Function,
 *   writeOutput?: (value: unknown) => void,
 * }} [deps]
 */
export async function runDeviceEnrollCommand(args, deps = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw deviceCommandArgsInvalidError();
  }
  const record = /** @type {Record<string, unknown>} */ (args);
  // Reject argv secrets before any other work.
  if (record['enrollment-code'] !== undefined || record.token !== undefined) {
    throw new Error('device-enroll accepts secrets from stdin and Keychain only');
  }
  if (record['enrollment-code-stdin'] !== true) {
    throw new Error('--enrollment-code-stdin is required');
  }
  assertDeviceCommandPublicArgs(record);

  const input = deps.input ?? process.stdin;
  const credentialStore = deps.credentialStore ?? createDefaultDeviceCredentialStore();
  const enroll = deps.enroll ?? enrollDevice;
  const writeOutput = deps.writeOutput
    ?? ((value) => console.log(JSON.stringify(value, null, 2)));

  const result = await enroll({
    agentUrl: record.server,
    tlsFingerprint: record['tls-fingerprint'],
    deviceId: record.device,
    enrollmentCode: await readSingleSecretLine(input),
    credentialStore,
  });
  writeOutput(result);
  return result;
}

/**
 * device-heartbeat: token only from Keychain.
 * Public args validated before Keychain construction or heartbeat.
 * @param {Record<string, unknown>} args
 * @param {{
 *   credentialStore?: { getToken: Function, setToken: Function },
 *   heartbeat?: Function,
 *   writeOutput?: (value: unknown) => void,
 * }} [deps]
 */
export async function runDeviceHeartbeatCommand(args, deps = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw deviceCommandArgsInvalidError();
  }
  const record = /** @type {Record<string, unknown>} */ (args);
  if (record.token !== undefined) {
    throw new Error('device-heartbeat reads the token from Keychain');
  }
  assertDeviceCommandPublicArgs(record);

  const credentialStore = deps.credentialStore ?? createDefaultDeviceCredentialStore();
  const heartbeat = deps.heartbeat ?? heartbeatDevice;
  const writeOutput = deps.writeOutput
    ?? ((value) => console.log(JSON.stringify(value, null, 2)));

  const result = await heartbeat({
    agentUrl: record.server,
    tlsFingerprint: record['tls-fingerprint'],
    deviceId: record.device,
    hostname: record.hostname,
    credentialStore,
  });
  writeOutput(result);
  return result;
}

/**
 * device-token-rotate: token only from Keychain.
 * Public args validated before Keychain construction or rotate.
 * @param {Record<string, unknown>} args
 * @param {{
 *   credentialStore?: { getToken: Function, setToken: Function },
 *   rotate?: Function,
 *   writeOutput?: (value: unknown) => void,
 * }} [deps]
 */
export async function runDeviceTokenRotateCommand(args, deps = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw deviceCommandArgsInvalidError();
  }
  const record = /** @type {Record<string, unknown>} */ (args);
  if (record.token !== undefined) {
    throw new Error('device-token-rotate reads the token from Keychain');
  }
  assertDeviceCommandPublicArgs(record);

  const credentialStore = deps.credentialStore ?? createDefaultDeviceCredentialStore();
  const rotate = deps.rotate ?? rotateDeviceToken;
  const writeOutput = deps.writeOutput
    ?? ((value) => console.log(JSON.stringify(value, null, 2)));

  const result = await rotate({
    agentUrl: record.server,
    tlsFingerprint: record['tls-fingerprint'],
    deviceId: record.device,
    credentialStore,
  });
  writeOutput(result);
  return result;
}

// ── Usage ──────────────────────────────────────────────────────────

export function printUsage() {
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
  nas-snapshot-replicate Plan/execute/recover mounted SMB snapshot replication
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
  supervisor-lifecycle-guarded-runner-readiness Show sanitized supervisor lifecycle guarded runner binding readiness
  supervisor-lifecycle-guarded-runner-execution-preview Show sanitized supervisor lifecycle guarded runner execution preview
  supervisor-lifecycle-guarded-runner-execution-gate Show sanitized supervisor lifecycle guarded runner execution gate
  audit-log           Show sanitized local audit events
  audit-integrity-monitor Run-once local audit integrity monitor (JSON on stdout; no network; no write)
  audit-integrity-rotate Explicitly rotate the local audit integrity generation (local only)
  audit-integrity-rotation-recover Explicitly recover a local audit integrity rotation (local only)
  release-readiness   Evaluate release readiness from health status
  gold-readiness      Show Gold readiness blocker scorecard
  device-enroll       Enroll device via HTTPS Agent URL with certificate pin (code from stdin only)
  device-heartbeat    Authenticated device heartbeat (device token from Keychain only)
  device-token-rotate Rotate device token (device token from Keychain only)
  management-auth-rotate Rotate management auth Keychain token under cross-process lock

Options:
  --server <url>       Server URL (default: http://localhost:3000). device-* commands require an HTTPS Agent URL only
  --device <id>        Device ID
  --source <path>      Source path (for backup)
  --exclude <pattern>  Exclude pattern (repeatable for backup-preflight-dry-run)
  --target <path>      Target path (for restore)
  --snapshot <id>      Snapshot ID (for restore)
  --hostname <name>    Hostname
  --ip <address>       IP address
  --config <path>      Config file path (for run-once, launchd-dry-run, supervisor-install-dry-run, nas-dry-run, nas-snapshot-replicate, supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-executor-manifest-readiness, supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
  --operation <operation> Supervisor lifecycle operation (for supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-executor-manifest-readiness, supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
  --output <path>      Output path (for launchd-dry-run, project dir only)
  --keep-last <n>      Snapshots to keep (for retention-dry-run, default: 3)
  --limit <n>          Limit read-only audit-log events
  --expected-version <version> Expected release version (for release-readiness)
  --readiness-summary  Print only readinessSummary for nas-dry-run or supervisor-install-dry-run
  --fail-on-blocked   Exit 2 when supported readiness/status output is blocked
  --execute            Enable mounted SMB replication writes (nas-snapshot-replicate; requires LINKE_NAS_SMB_EXECUTION=enabled)
  --recover            Explicit stale recovery (nas-snapshot-replicate; requires --execute)
  --device-id <id>     Device ID (nas-snapshot-replicate)
  --snapshot-id <id>   Snapshot ID (nas-snapshot-replicate)
  --execute-requested Record explicit execution intent for the guarded runner execution gate without executing
  --token <token>      Bearer token for authenticated Linke Server management requests (not accepted by device-enroll / device-heartbeat / device-token-rotate)
  --tls-fingerprint <hex> Admin-confirmed Agent certificate SHA-256 fingerprint (64 hex, colons optional; independent channel)
  --enrollment-code-stdin Required for device-enroll: read one-time enrollment code from stdin (max 4096 bytes, single line). Enrollment codes and device tokens are never accepted as CLI arguments; tokens are stored and read only via Keychain
  --scope <read|write>  Management auth scope to rotate (management-auth-rotate)
  --token-stdin        Read the new management auth token from stdin (management-auth-rotate; token is never accepted as a CLI argument)
  --approval <path>    Approval JSON file path (for supervisor-lifecycle-apply, supervisor-lifecycle-approval-persistence-preview, supervisor-lifecycle-approval-persist)
  --manifest <path>    Executor manifest JSON file path (for supervisor-lifecycle-executor-manifest-readiness, supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
  --runner-binding <path> Guarded runner binding JSON file path (for supervisor-lifecycle-guarded-runner-readiness, supervisor-lifecycle-guarded-runner-execution-preview, supervisor-lifecycle-guarded-runner-execution-gate)
  --data-dir <path>    Data directory (for nas-snapshot-replicate, supervisor-lifecycle-approval-persist, supervisor-lifecycle-apply-readiness, supervisor-lifecycle-executor-readiness, supervisor-lifecycle-guarded-runner-execution-gate, audit-integrity-monitor, audit-integrity-rotate, audit-integrity-rotation-recover, management-auth-rotate)
  --expected-generation-id <hex> Expected audit generation ID (audit-integrity-rotate; 32 lowercase hex)
  --expected-head-digest <hex> Expected audit journal head digest (audit-integrity-rotate; 64 lowercase hex)
`);
}

// ── Main ───────────────────────────────────────────────────────────

export async function main() {
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  const command = args._[0];
  const server = args.server || 'http://localhost:3000';
  const requestOptions = args.token && args.token !== true ? { authToken: args.token } : {};
  const apiRequest = (path, method, body) => request(server, path, method, body, requestOptions);

  // Local audit-integrity commands own --help/--h via strict argv validators
  // (exit 1 with their fixed phrase).
  // Other commands keep the existing early-help behavior unchanged.
  if (
    !AUDIT_INTEGRITY_LOCAL_STRICT_COMMANDS.has(command)
    && (!command || args.help || args.h || command === 'help')
  ) {
    printUsage();
    process.exit(args.help || args.h || command === 'help' ? 0 : 1);
  }

  try {
    // Skip the global bare-token trap for strict local commands so their own
    // validators own `--token` (fixed path-free phrase, exit 1).
    if (!AUDIT_INTEGRITY_LOCAL_STRICT_COMMANDS.has(command) && args.token === true) {
      throw new Error('--token requires a value');
    }

    switch (command) {
      case 'audit-integrity-monitor': {
        // Validator stays outside execution try so argv errors keep the fixed invalid phrase.
        assertAuditIntegrityMonitorArgs(args, rawArgv);
        try {
          const report = await runAuditIntegrityMonitor(args['data-dir']);
          process.stdout.write(formatAuditIntegrityMonitorReportJson(report));
          process.exitCode = auditIntegrityMonitorExitCode(report);
        } catch {
          // Programmer/runtime misuse after valid argv: fixed desensitized exit 1.
          // Never echo raw err.message / path / token; never forge alert JSON or exit 2.
          throw new Error(AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR);
        }
        break;
      }

      case 'audit-integrity-rotate': {
        const parsed = parseAuditIntegrityRotateArgs(rawArgv);
        try {
          const receipt = await rotateAuditIntegrityGeneration(parsed.dataDir, {
            expectedGenerationId: parsed.expectedGenerationId,
            expectedHeadDigest: parsed.expectedHeadDigest,
          });
          process.stdout.write(`${JSON.stringify(receipt)}\n`);
        } catch (error) {
          if (isAuditIntegrityRefusal(error)) {
            console.error(`Error: ${AUDIT_INTEGRITY_ROTATE_REFUSED_ERROR}`);
            process.exitCode = 2;
            break;
          }
          throw new Error(AUDIT_INTEGRITY_ROTATE_EXECUTION_ERROR);
        }
        break;
      }

      case 'audit-integrity-rotation-recover': {
        const parsed = parseAuditIntegrityRotationRecoverArgs(rawArgv);
        try {
          const receipt = await recoverAuditIntegrityRotation(parsed.dataDir);
          process.stdout.write(`${JSON.stringify(receipt)}\n`);
        } catch (error) {
          if (isAuditIntegrityRefusal(error)) {
            console.error(`Error: ${AUDIT_INTEGRITY_ROTATION_RECOVER_REFUSED_ERROR}`);
            process.exitCode = 2;
            break;
          }
          throw new Error(AUDIT_INTEGRITY_ROTATION_RECOVER_EXECUTION_ERROR);
        }
        break;
      }

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

      case 'nas-snapshot-replicate': {
        // Keep all failures inside this case so generic catch never echoes raw err.message.
        let auditDataDir;
        try {
          assertNasReplicationArgs(args);
          requireNasReplicationValue(args, 'config');
          requireNasReplicationValue(args, 'data-dir');
          requireNasReplicationValue(args, 'target');
          requireNasReplicationValue(args, 'device-id');
          requireNasReplicationValue(args, 'snapshot-id');
          assertNasReplicationBooleanFlag(args, 'execute');
          assertNasReplicationBooleanFlag(args, 'recover');
          if (args.recover === true && args.execute !== true) {
            throw new SmbReplicationError('smb-execution-blocked', 2);
          }

          auditDataDir = args['data-dir'];
          const config = validateConfig(await loadConfig(args.config));
          const replicationOptions = {
            config,
            dataDir: args['data-dir'],
            targetName: args.target,
            deviceId: args['device-id'],
            snapshotId: args['snapshot-id'],
            execute: args.execute === true,
            recover: args.recover === true,
            executionGate: process.env.LINKE_NAS_SMB_EXECUTION,
          };

          if (replicationOptions.execute) {
            await recordRequiredNasReplicationStartAudit(auditDataDir, {
              targetName: replicationOptions.targetName,
              deviceId: replicationOptions.deviceId,
              snapshotId: replicationOptions.snapshotId,
            });
          }

          const result = replicationOptions.recover === true
            ? await recoverMountedSmbSnapshot(replicationOptions)
            : replicationOptions.execute === true
              ? await replicateSnapshotToMountedSmb(replicationOptions)
              : await buildSmbSnapshotReplicationPlan(replicationOptions);

          if (!result || !NAS_REPLICATION_SUCCESS_STATES.has(result.state)) {
            throw new SmbReplicationError('nas-snapshot-replicate-failed', 1);
          }

          await appendNasReplicationAudit(auditDataDir, {
            type: nasReplicationAuditTypeForState(result.state),
            ...nasReplicationAuditFieldsFromResult(result),
          });

          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          // FIRST: fixed-code recognition (LinkeError OR equivalent object).
          // Must not rely on instanceof LinkeError alone; precedes SmbReplicationError/generic.
          if (err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE) {
            await appendNasReplicationAudit(auditDataDir, {
              type: 'nas.snapshot.replication.failed',
              outcome: 'failure',
              errorCode: ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE,
              targetName: typeof args.target === 'string' ? args.target : undefined,
              deviceId: typeof args['device-id'] === 'string' ? args['device-id'] : undefined,
              snapshotId: typeof args['snapshot-id'] === 'string' ? args['snapshot-id'] : undefined,
            });
            console.error('Error: audit-delivery-unavailable');
            process.exit(1);
          }
          if (err instanceof SmbReplicationError) {
            const auditType = err.code === 'recovery_required'
              ? 'nas.snapshot.replication.recovery_required'
              : 'nas.snapshot.replication.failed';
            await appendNasReplicationAudit(auditDataDir, {
              type: auditType,
              outcome: 'failure',
              errorCode: err.code,
              targetName: typeof args.target === 'string' ? args.target : undefined,
              deviceId: typeof args['device-id'] === 'string' ? args['device-id'] : undefined,
              snapshotId: typeof args['snapshot-id'] === 'string' ? args['snapshot-id'] : undefined,
            });
            console.error(`Error: ${err.code}`);
            process.exit(err.exitCode);
          }
          await appendNasReplicationAudit(auditDataDir, {
            type: 'nas.snapshot.replication.failed',
            outcome: 'failure',
            errorCode: 'nas-snapshot-replicate-failed',
            targetName: typeof args.target === 'string' ? args.target : undefined,
            deviceId: typeof args['device-id'] === 'string' ? args['device-id'] : undefined,
            snapshotId: typeof args['snapshot-id'] === 'string' ? args['snapshot-id'] : undefined,
          });
          console.error('Error: nas-snapshot-replicate-failed');
          process.exit(1);
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

      case 'supervisor-lifecycle-guarded-runner-readiness': {
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
        if (!args['runner-binding']) {
          throw new Error('--runner-binding is required');
        }
        if (args['runner-binding'] === true) {
          throw new Error('--runner-binding requires a path value');
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
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_CONFIG_ERROR);
        }

        let manifest;
        try {
          const rawManifest = await readFile(args.manifest, 'utf-8');
          manifest = JSON.parse(rawManifest);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_MANIFEST_ERROR);
        }

        let runnerBinding;
        try {
          const rawBinding = await readFile(args['runner-binding'], 'utf-8');
          runnerBinding = JSON.parse(rawBinding);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_BINDING_ERROR);
        }

        const plan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
        });

        let guardedRunnerReadiness;
        try {
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, manifest);
          guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
            manifestReadiness,
            runnerBinding,
          );
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_VALIDATION_ERROR);
        }

        console.log(JSON.stringify(guardedRunnerReadiness, null, 2));

        if (args['fail-on-blocked'] === true && guardedRunnerReadiness.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-guarded-runner-execution-preview': {
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
        if (!args['runner-binding']) {
          throw new Error('--runner-binding is required');
        }
        if (args['runner-binding'] === true) {
          throw new Error('--runner-binding requires a path value');
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
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR);
        }

        let manifest;
        try {
          const rawManifest = await readFile(args.manifest, 'utf-8');
          manifest = JSON.parse(rawManifest);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_MANIFEST_ERROR);
        }

        let runnerBinding;
        try {
          const rawBinding = await readFile(args['runner-binding'], 'utf-8');
          runnerBinding = JSON.parse(rawBinding);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_BINDING_ERROR);
        }

        const plan = buildSupervisorLifecycleApplyPlan(config, {
          operation: args.operation,
          apply: true,
          envGateEnabled: true,
        });

        let executionPreview;
        try {
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, manifest);
          const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
            manifestReadiness,
            runnerBinding,
          );
          executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
            plan,
            guardedRunnerReadiness,
          );
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR);
        }

        console.log(JSON.stringify(executionPreview, null, 2));

        if (args['fail-on-blocked'] === true && executionPreview.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'supervisor-lifecycle-guarded-runner-execution-gate': {
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
        if (!args.manifest) {
          throw new Error('--manifest is required');
        }
        if (args.manifest === true) {
          throw new Error('--manifest requires a path value');
        }
        if (!args['runner-binding']) {
          throw new Error('--runner-binding is required');
        }
        if (args['runner-binding'] === true) {
          throw new Error('--runner-binding requires a path value');
        }
        if (args.apply !== undefined) {
          throw new Error('--apply is not supported');
        }
        if (args.approval !== undefined) {
          throw new Error('--approval is not supported');
        }
        if (args.output !== undefined) {
          throw new Error('--output is not supported');
        }
        if (args['execute-requested'] !== undefined && args['execute-requested'] !== true) {
          throw new Error('--execute-requested does not accept a value');
        }
        if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
          throw new Error('--fail-on-blocked does not accept a value');
        }

        let config;
        try {
          const raw = await loadConfig(args.config);
          config = validateConfig(raw);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR);
        }

        let approvalRecords;
        try {
          approvalRecords = await readSupervisorLifecycleApprovalRecords(args['data-dir']);
        } catch (err) {
          throw new Error('failed to read supervisor lifecycle approval records');
        }

        let manifest;
        try {
          const rawManifest = await readFile(args.manifest, 'utf-8');
          manifest = JSON.parse(rawManifest);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_MANIFEST_ERROR);
        }

        let runnerBinding;
        try {
          const rawBinding = await readFile(args['runner-binding'], 'utf-8');
          runnerBinding = JSON.parse(rawBinding);
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_BINDING_ERROR);
        }

        let gate;
        try {
          const plan = buildSupervisorLifecycleApplyPlan(config, {
            operation: args.operation,
            apply: true,
            envGateEnabled: true,
          });
          const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, approvalRecords);
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, manifest);
          const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
            manifestReadiness,
            runnerBinding,
          );
          const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
            plan,
            guardedRunnerReadiness,
          );
          gate = buildSupervisorLifecycleGuardedRunnerExecutionGate(
            plan,
            applyReadiness,
            manifestReadiness,
            guardedRunnerReadiness,
            executionPreview,
            { executeRequested: args['execute-requested'] === true },
          );
        } catch (err) {
          throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR);
        }

        console.log(JSON.stringify(gate, null, 2));

        if (args['fail-on-blocked'] === true && gate.state === 'blocked') {
          process.exitCode = 2;
        }
        break;
      }

      case 'management-auth-rotate': {
        try {
          await runManagementAuthRotateCommand(rawArgv);
        } catch (error) {
          let message = MANAGEMENT_AUTH_ROTATE_EXECUTION_ERROR;
          let exitCode = 1;
          if (error instanceof ManagementAuthRotateCommandError) {
            if (error.code === 'management-auth-rotate-arguments-invalid') {
              message = MANAGEMENT_AUTH_ROTATE_ARGUMENTS_ERROR;
            } else if (error.code === 'management-auth-rotate-stdin-invalid') {
              message = MANAGEMENT_AUTH_ROTATE_STDIN_ERROR;
            }
          } else if (
            error instanceof ManagementAuthRotationError
            || error instanceof ManagementAuthRotationProcessLockError
          ) {
            message = MANAGEMENT_AUTH_ROTATE_REFUSED_ERROR;
            exitCode = 2;
          }
          process.stderr.write(`Error: ${message}\n`);
          process.exitCode = exitCode;
        }
        break;
      }

      case 'device-enroll': {
        await runDeviceEnrollCommand(args);
        break;
      }

      case 'device-heartbeat': {
        await runDeviceHeartbeatCommand(args);
        break;
      }

      case 'device-token-rotate': {
        await runDeviceTokenRotateCommand(args);
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
