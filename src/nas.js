/**
 * NAS Provider Dry-Run Module
 *
 * Validates NAS target configurations and produces dry-run plans
 * without making any network connections or writes.
 *
 * Supported providers: synology, ugreen
 */

import {
  loadConfig,
  validateConfig,
  assertNoCredentials,
  validateNasCredentialRef,
  validateNasMountedShare,
} from './config.js';

const VALID_PROVIDERS = ['synology', 'ugreen'];

const VALID_APP_ADAPTERS = Object.freeze({
  synology: ['synology-backup', 'synology-files'],
  ugreen: ['ugreen-backup', 'ugreen-files'],
});

const BACKUP_ADAPTER_STEPS = Object.freeze([
  'validate-target',
  'prepare-app-request',
  'map-backup-jobs',
  'preview-remote-destination',
]);

const FILES_ADAPTER_STEPS = Object.freeze([
  'validate-target',
  'prepare-file-browser-request',
  'map-share-and-path',
  'preview-file-operation',
]);

const NAS_DRY_RUN_SCHEMA_VERSION = 2;

const NAS_REQUIRED_EXECUTION_GATES = Object.freeze([
  Object.freeze({ type: 'cli-flag', name: '--execute' }),
  Object.freeze({ type: 'env-var', name: 'LINKE_NAS_SMB_EXECUTION' }),
]);

const NAS_EXECUTION_GATE = Object.freeze({
  schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION,
  adapterAvailable: true,
  executionAuthorized: false,
  remoteExecutionAllowed: false,
  blockingReason: 'dry-run does not authorize execution',
  requiredGates: NAS_REQUIRED_EXECUTION_GATES,
});

export const NAS_EXECUTION_READINESS_BLOCKERS = Object.freeze({
  NO_TARGETS_CONFIGURED: 'no-targets-configured',
  TARGET_DISABLED: 'target-disabled',
  MOUNTED_SHARE_MISSING: 'mounted-share-missing',
  MOUNTED_SHARE_DISABLED: 'mounted-share-disabled',
  // Compatibility exports only — never pushed into active V2 blockers.
  CREDENTIAL_REF_MISSING: 'credential-ref-missing',
  REMOTE_EXECUTION_BLOCKED: 'remote-execution-blocked',
});

function validateNasAppAdapter(provider, appAdapter) {
  if (appAdapter === undefined || appAdapter === null) return null;
  if (!appAdapter || typeof appAdapter !== 'object' || Array.isArray(appAdapter)) {
    throw new Error('nasTargets[].appAdapter must be an object');
  }

  assertNoCredentials(appAdapter);

  if (!appAdapter.appId || typeof appAdapter.appId !== 'string' || appAdapter.appId.trim() === '') {
    throw new Error('nasTargets[].appAdapter.appId must be a non-empty string');
  }

  const allowed = VALID_APP_ADAPTERS[provider] || [];
  if (!allowed.includes(appAdapter.appId)) {
    throw new Error(
      `nasTargets[].appAdapter.appId "${appAdapter.appId}" is not supported for provider "${provider}"`,
    );
  }

  if (appAdapter.operation !== undefined
    && (typeof appAdapter.operation !== 'string' || appAdapter.operation.trim() === '')) {
    throw new Error('nasTargets[].appAdapter.operation must be a non-empty string');
  }

  return {
    appId: appAdapter.appId,
    operation: appAdapter.operation || 'backup-plan',
  };
}

/**
 * Validate a single NAS target object.
 * Returns a normalised copy with defaults applied.
 * Throws on invalid input.
 */
export function validateNasTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new Error('NAS target must be an object');
  }

  // ── name ──────────────────────────────────────────────────────
  if (!target.name || typeof target.name !== 'string' || target.name.trim() === '') {
    throw new Error('nasTargets[].name must be a non-empty string');
  }

  // ── provider ──────────────────────────────────────────────────
  if (!VALID_PROVIDERS.includes(target.provider)) {
    throw new Error(
      `nasTargets[].provider must be one of: ${VALID_PROVIDERS.join(', ')} (got "${target.provider}")`,
    );
  }

  // ── endpoint ──────────────────────────────────────────────────
  if (!target.endpoint || typeof target.endpoint !== 'string') {
    throw new Error('nasTargets[].endpoint must be a non-empty string');
  }
  try {
    const url = new URL(target.endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('nasTargets[].endpoint must be http or https');
    }
  } catch (e) {
    if (e.message.includes('endpoint')) throw e;
    throw new Error('nasTargets[].endpoint must be a valid URL');
  }

  // ── credential / userinfo rejection ─────────────────────────────
  assertNoCredentials(target);

  // ── shareName ─────────────────────────────────────────────────
  if (!target.shareName || typeof target.shareName !== 'string' || target.shareName.trim() === '') {
    throw new Error('nasTargets[].shareName must be a non-empty string');
  }

  // ── remotePath ────────────────────────────────────────────────
  if (!target.remotePath || typeof target.remotePath !== 'string' || target.remotePath.trim() === '') {
    throw new Error('nasTargets[].remotePath must be a non-empty string');
  }

  // ── enabled (default true) ────────────────────────────────────
  const enabled = target.enabled !== undefined ? Boolean(target.enabled) : true;

  const credentialRef = validateNasCredentialRef(target.credentialRef);
  const appAdapter = validateNasAppAdapter(target.provider, target.appAdapter);
  const mountedShare = validateNasMountedShare(target.mountedShare);

  return {
    name: target.name,
    provider: target.provider,
    endpoint: target.endpoint,
    shareName: target.shareName,
    remotePath: target.remotePath,
    enabled,
    appAdapter,
    credentialRef,
    mountedShare,
  };
}

/**
 * Derive target execution readiness from configuration only, using this exact
 * branch order: disabled target, missing mounted share, disabled mounted share.
 */
export function getTargetExecutionReadiness(target) {
  let blocker = null;
  if (!target.enabled) {
    blocker = NAS_EXECUTION_READINESS_BLOCKERS.TARGET_DISABLED;
  } else if (!target.mountedShare) {
    blocker = NAS_EXECUTION_READINESS_BLOCKERS.MOUNTED_SHARE_MISSING;
  } else if (!target.mountedShare.enabled) {
    blocker = NAS_EXECUTION_READINESS_BLOCKERS.MOUNTED_SHARE_DISABLED;
  }

  const blockers = blocker ? [blocker] : [];
  const ready = blockers.length === 0;
  return {
    schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION,
    state: ready ? 'ready' : 'blocked',
    basis: 'configuration-only',
    blockers,
    runtimeVerificationPerformed: false,
    runtimeVerificationRequired: ready,
  };
}

/**
 * Build readiness summary counts and aggregated blockers from target readiness rows.
 */
export function buildReadinessSummary(targets) {
  const totalTargets = targets.length;
  let enabledTargets = 0;
  let disabledTargets = 0;
  let credentialRefConfiguredTargets = 0;
  let enabledCredentialRefMissingTargets = 0;
  let mountedShareConfiguredTargets = 0;
  let mountedShareEnabledTargets = 0;
  let configurationReadyTargets = 0;
  let runtimeVerificationPendingTargets = 0;
  let blockedTargets = 0;
  const uniqueBlockers = new Set();

  if (totalTargets === 0) {
    uniqueBlockers.add(NAS_EXECUTION_READINESS_BLOCKERS.NO_TARGETS_CONFIGURED);
  }

  for (const t of targets) {
    if (t.enabled) {
      enabledTargets++;
    } else {
      disabledTargets++;
    }

    if (t.credentialRefConfigured) {
      credentialRefConfiguredTargets++;
    }

    if (t.enabled && !t.credentialRefConfigured) {
      enabledCredentialRefMissingTargets++;
    }

    if (t.mountedShareConfigured) {
      mountedShareConfiguredTargets++;
    }

    if (t.mountedShareEnabled) {
      mountedShareEnabledTargets++;
    }

    if (t.executionReadiness.state === 'ready') {
      configurationReadyTargets++;
    } else {
      blockedTargets++;
    }

    if (t.executionReadiness.runtimeVerificationRequired) {
      runtimeVerificationPendingTargets++;
    }

    for (const b of t.executionReadiness.blockers) {
      uniqueBlockers.add(b);
    }
  }

  const blockers = Array.from(uniqueBlockers);
  const state = blockedTargets > 0 || totalTargets === 0 ? 'blocked' : 'ready';

  return {
    schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION,
    mode: 'dry-run',
    scope: 'configuration-only',
    state,
    totalTargets,
    enabledTargets,
    disabledTargets,
    credentialRefConfiguredTargets,
    enabledCredentialRefMissingTargets,
    mountedShareConfiguredTargets,
    mountedShareEnabledTargets,
    configurationReadyTargets,
    runtimeVerificationPendingTargets,
    blockedTargets,
    executionAuthorized: false,
    remoteExecutionBlocked: true,
    blockers,
  };
}

/**
 * Build a NAS dry-run plan from a validated config object.
 * The plan describes what *would* happen without connecting or writing.
 */
export function buildNasDryRunPlan(config) {
  const nasTargets = config.nasTargets || [];
  const validatedTargets = nasTargets.map((t) => validateNasTarget(t));

  const targets = validatedTargets.map((t) => {
    const credentialRefConfigured = Boolean(t.credentialRef);
    const executionReadiness = getTargetExecutionReadiness(t);
    return {
      provider: t.provider,
      name: t.name,
      endpoint: t.endpoint,
      shareName: t.shareName,
      remotePath: t.remotePath,
      enabled: t.enabled,
      credentialRefConfigured,
      mountedShareConfigured: Boolean(t.mountedShare),
      mountedShareEnabled: Boolean(t.mountedShare?.enabled),
      executionReadiness,
      appAdapter: t.appAdapter,
      adapterPlan: buildNasAppAdapterDryRunPlan(t, config.backupJobs || []),
    };
  });

  const readinessSummary = buildReadinessSummary(targets);

  return {
    schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION,
    mode: 'dry-run',
    deviceId: config.deviceId,
    wouldConnect: false,
    wouldWrite: false,
    executionGate: {
      ...NAS_EXECUTION_GATE,
      requiredGates: NAS_EXECUTION_GATE.requiredGates.map((gate) => ({ ...gate })),
    },
    readinessSummary,
    targets,
    jobs: (config.backupJobs || []).map((j) => ({
      name: j.name,
      sourcePath: j.sourcePath,
    })),
  };
}

/**
 * Build an app adapter dry-run plan for a single NAS target.
 * Returns null if the target has no appAdapter.
 */
export function buildNasAppAdapterDryRunPlan(target, jobs = []) {
  if (!target.appAdapter) return null;
  const steps = target.appAdapter.appId.endsWith('-files')
    ? FILES_ADAPTER_STEPS
    : BACKUP_ADAPTER_STEPS;

  return {
    mode: 'dry-run',
    provider: target.provider,
    appId: target.appAdapter.appId,
    operation: target.appAdapter.operation,
    wouldInvokeApp: false,
    wouldConnect: false,
    wouldWrite: false,
    steps: [...steps],
    jobCount: jobs.length,
  };
}

/**
 * Load config from `configPath`, validate, and return a NAS dry-run plan.
 * Does NOT make any network requests or write to any NAS.
 */
export async function runNasDryRunFromConfig(configPath) {
  const raw = await loadConfig(configPath);
  const config = validateConfig(raw);
  return buildNasDryRunPlan(config);
}
