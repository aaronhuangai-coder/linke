/**
 * NAS Provider Dry-Run Module
 *
 * Validates NAS target configurations and produces dry-run plans
 * without making any network connections or writes.
 *
 * Supported providers: synology, ugreen
 */

import { loadConfig, validateConfig, assertNoCredentials } from './config.js';

const VALID_PROVIDERS = ['synology', 'ugreen'];

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

  return {
    name: target.name,
    provider: target.provider,
    endpoint: target.endpoint,
    shareName: target.shareName,
    remotePath: target.remotePath,
    enabled,
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
    targets: validatedTargets.map((t) => ({
      provider: t.provider,
      name: t.name,
      endpoint: t.endpoint,
      shareName: t.shareName,
      remotePath: t.remotePath,
      enabled: t.enabled,
    })),
    jobs: (config.backupJobs || []).map((j) => ({
      name: j.name,
      sourcePath: j.sourcePath,
    })),
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
