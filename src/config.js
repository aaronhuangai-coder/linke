import { readFile } from 'node:fs/promises';
import { hostname as osHostname, networkInterfaces } from 'node:os';

/** Credential-like field names that must never appear in a nasTarget. */
export const FORBIDDEN_NAS_CREDENTIAL_FIELDS = Object.freeze([
  'username', 'password', 'token', 'apiKey', 'secret', 'accessKey', 'refreshToken',
]);

export const ALLOWED_NAS_CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Throw if a NAS target object contains credential-like fields or an
 * endpoint URL with embedded userinfo (user:pass@host).
 * Shared by validateConfig (config.js) and validateNasTarget (nas.js).
 */
export function assertNoCredentials(target) {
  for (const field of FORBIDDEN_NAS_CREDENTIAL_FIELDS) {
    if (field in target) {
      throw new Error(
        `nasTargets[] must not contain credential field "${field}"`,
      );
    }
  }
  if (target.endpoint) {
    try {
      const url = new URL(target.endpoint);
      if (url.username || url.password) {
        throw new Error(
          'nasTargets[].endpoint must not contain credentials (userinfo)',
        );
      }
    } catch (e) {
      if (e.message.includes('credential')) throw e;
      // URL parse errors handled elsewhere; ignore here.
    }
  }
}

/**
 * 校验 NAS 凭证引用名；这里只接受非密钥 slug，不读取或解析任何凭证值。
 */
export function validateNasCredentialRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ALLOWED_NAS_CREDENTIAL_REF_PATTERN.test(value)) {
    throw new Error('nasTargets[].credentialRef must match ^[a-z][a-z0-9-]{1,30}$');
  }
  return value;
}

/**
 * Return the first non-internal IPv4 address, falling back to IPv6, then 'unknown'.
 * Does NOT read environment variables.
 */
export function getDefaultIpAddress() {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv6' && !iface.internal) return iface.address;
    }
  }
  return 'unknown';
}

/** Read and parse a JSON config file. */
export async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Validate a raw config object and return a normalised copy with defaults applied.
 * Throws on invalid input.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  // ── serverUrl ──────────────────────────────────────────────
  if (!config.serverUrl || typeof config.serverUrl !== 'string') {
    throw new Error('serverUrl is required');
  }
  try {
    const url = new URL(config.serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('serverUrl must be http or https');
    }
  } catch (e) {
    if (e.message.includes('serverUrl')) throw e;
    throw new Error('serverUrl must be a valid URL');
  }

  // ── deviceId ───────────────────────────────────────────────
  if (!config.deviceId || typeof config.deviceId !== 'string' || config.deviceId.trim() === '') {
    throw new Error('deviceId must be a non-empty string');
  }

  // ── backupJobs ─────────────────────────────────────────────
  if (!Array.isArray(config.backupJobs) || config.backupJobs.length === 0) {
    throw new Error('backupJobs must be a non-empty array');
  }
  for (const job of config.backupJobs) {
    if (!job.name || typeof job.name !== 'string' || job.name.trim() === '') {
      throw new Error('backupJobs[].name must be a non-empty string');
    }
    if (!job.sourcePath || typeof job.sourcePath !== 'string' || job.sourcePath.trim() === '') {
      throw new Error('backupJobs[].sourcePath must be a non-empty string');
    }
  }

  // ── scheduleSeconds (optional) ─────────────────────────────
  if (config.scheduleSeconds !== undefined) {
    if (!Number.isInteger(config.scheduleSeconds) || config.scheduleSeconds <= 0) {
      throw new Error('scheduleSeconds must be a positive integer');
    }
  }

  // ── nasTargets (optional) ──────────────────────────────────
  const VALID_NAS_PROVIDERS = ['synology', 'ugreen'];
  let nasTargets = [];
  if (config.nasTargets !== undefined) {
    if (!Array.isArray(config.nasTargets)) {
      throw new Error('nasTargets must be an array');
    }
    for (const t of config.nasTargets) {
      assertNoCredentials(t);
      if (!t.name || typeof t.name !== 'string' || t.name.trim() === '') {
        throw new Error('nasTargets[].name must be a non-empty string');
      }
      if (!VALID_NAS_PROVIDERS.includes(t.provider)) {
        throw new Error(
          `nasTargets[].provider must be one of: ${VALID_NAS_PROVIDERS.join(', ')} (got "${t.provider}")`,
        );
      }
      if (!t.endpoint || typeof t.endpoint !== 'string') {
        throw new Error('nasTargets[].endpoint must be a non-empty string');
      }
      try {
        const url = new URL(t.endpoint);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('nasTargets[].endpoint must be http or https');
        }
      } catch (e) {
        if (e.message.includes('endpoint')) throw e;
        throw new Error('nasTargets[].endpoint must be a valid URL');
      }
      if (!t.shareName || typeof t.shareName !== 'string' || t.shareName.trim() === '') {
        throw new Error('nasTargets[].shareName must be a non-empty string');
      }
      if (!t.remotePath || typeof t.remotePath !== 'string' || t.remotePath.trim() === '') {
        throw new Error('nasTargets[].remotePath must be a non-empty string');
      }

      let appAdapter = null;
      if (t.appAdapter !== undefined) {
        if (!t.appAdapter || typeof t.appAdapter !== 'object' || Array.isArray(t.appAdapter)) {
          throw new Error('nasTargets[].appAdapter must be an object');
        }
        assertNoCredentials(t.appAdapter);
        if (!t.appAdapter.appId || typeof t.appAdapter.appId !== 'string' || t.appAdapter.appId.trim() === '') {
          throw new Error('nasTargets[].appAdapter.appId must be a non-empty string');
        }
        const validApps = {
          synology: ['synology-backup', 'synology-files'],
          ugreen: ['ugreen-backup', 'ugreen-files'],
        };
        if (!validApps[t.provider].includes(t.appAdapter.appId)) {
          throw new Error(
            `nasTargets[].appAdapter.appId "${t.appAdapter.appId}" is not supported for provider "${t.provider}"`,
          );
        }
        if (t.appAdapter.operation !== undefined
          && (typeof t.appAdapter.operation !== 'string' || t.appAdapter.operation.trim() === '')) {
          throw new Error('nasTargets[].appAdapter.operation must be a non-empty string');
        }
        appAdapter = {
          appId: t.appAdapter.appId,
          operation: t.appAdapter.operation || 'backup-plan',
        };
      }
      const credentialRef = validateNasCredentialRef(t.credentialRef);

      nasTargets.push({
        name: t.name,
        provider: t.provider,
        endpoint: t.endpoint,
        shareName: t.shareName,
        remotePath: t.remotePath,
        enabled: t.enabled !== undefined ? Boolean(t.enabled) : true,
        appAdapter,
        credentialRef,
      });
    }
  }

  // ── Normalised output ──────────────────────────────────────
  return {
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    hostname: config.hostname || osHostname(),
    ipAddress: config.ipAddress || getDefaultIpAddress(),
    backupJobs: config.backupJobs,
    excludePatterns: Array.isArray(config.excludePatterns) ? config.excludePatterns : [],
    scheduleSeconds: config.scheduleSeconds || 3600,
    launchdLabel: config.launchdLabel || `com.linke.agent.${config.deviceId}`,
    nasTargets,
  };
}
