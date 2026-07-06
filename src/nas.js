/**
 * NAS Provider Dry-Run Module
 *
 * Validates NAS target configurations and produces dry-run plans
 * without making any network connections or writes.
 *
 * Supported providers: synology, ugreen
 */

import { loadConfig, validateConfig, assertNoCredentials, validateNasCredentialRef } from './config.js';

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

const NAS_EXECUTION_GATE = Object.freeze({
  remoteExecutionAllowed: false,
  blockingReason: 'real NAS transport not implemented',
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

  return {
    name: target.name,
    provider: target.provider,
    endpoint: target.endpoint,
    shareName: target.shareName,
    remotePath: target.remotePath,
    enabled,
    appAdapter,
    credentialRef,
  };
}

/**
 * Build a NAS dry-run plan from a validated config object.
 * The plan describes what *would* happen without connecting or writing.
 */
export function buildNasDryRunPlan(config) {
  const nasTargets = config.nasTargets || [];
  const validatedTargets = nasTargets.map((t) => validateNasTarget(t));

  return {
    mode: 'dry-run',
    deviceId: config.deviceId,
    wouldConnect: false,
    wouldWrite: false,
    executionGate: { ...NAS_EXECUTION_GATE },
    targets: validatedTargets.map((t) => ({
      provider: t.provider,
      name: t.name,
      endpoint: t.endpoint,
      shareName: t.shareName,
      remotePath: t.remotePath,
      enabled: t.enabled,
      credentialRefConfigured: Boolean(t.credentialRef),
      appAdapter: t.appAdapter,
      adapterPlan: buildNasAppAdapterDryRunPlan(t, config.backupJobs || []),
    })),
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
