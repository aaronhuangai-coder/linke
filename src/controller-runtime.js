import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createServer as createManagementServer, normalizeRestoreRoot } from './server.js';
import { createAgentListener } from './agent-listener.js';
import { DeviceRegistry } from './device-registry.js';
import { KeychainStore } from './keychain-store.js';
import { TlsIdentityStore } from './tls-identity-store.js';
import { recordHeartbeat } from './storage.js';
import { createFixedWindowRateLimiter, parseRateLimitPerMinute } from './rate-limit.js';
import { parseAuditRetentionMaxEvents } from './audit-log.js';
import { ensureSafeDataRoot, ensureSafeRelativeDir } from './safe-data-files.js';

const __filename = fileURLToPath(import.meta.url);

const DEFAULT_AGENT_PORT = 3443;
const DEFAULT_MANAGEMENT_PORT = 3000;
const DEFAULT_MANAGEMENT_HOST = '127.0.0.1';
const DEFAULT_AGENT_RATE_LIMIT = Object.freeze({ maxRequests: 60, windowMs: 60_000 });

/**
 * Listen helper used by production and tests (injectable).
 * @param {import('node:net').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<void>}
 */
function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    // Explicit off on every settle path (do not rely on once-wrapper auto-removal).
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.on('error', onError);
    try {
      server.listen(port, host, () => {
        server.off('error', onError);
        resolveListen();
      });
    } catch (error) {
      // Sync throw: Promise executor would still reject, but the startup listener
      // would otherwise leak — clear it, then rethrow via reject with the original error.
      server.off('error', onError);
      reject(error);
    }
  });
}

/**
 * Close a server if it is currently listening. Safe when server is missing.
 * Stops accepting new connections first, then force-drops keep-alive sockets when supported.
 * Order is always close → closeAllConnections so a concurrent accept cannot race open.
 * Promise settles only from the close callback (or immediately when not listening).
 * @param {import('node:net').Server | null | undefined} server
 * @returns {Promise<void>}
 */
export function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server?.listening) return resolveClose();
    server.close(() => resolveClose());
    // After close(): refuse new connections, then drain active keep-alive if available.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

/**
 * Install a permanent post-listen error handler that fail-closes status and notifies
 * with a fixed component name only (never the raw Error object).
 * @param {import('node:net').Server} server
 * @param {'agent' | 'management'} component
 * @param {{ agentListening: boolean, managementListening: boolean }} status
 * @param {(component: 'agent' | 'management') => void} onRuntimeError
 */
function attachPostListenErrorHandler(server, component, status, onRuntimeError) {
  const field = component === 'agent' ? 'agentListening' : 'managementListening';
  server.on('error', () => {
    status[field] = false;
    if (typeof onRuntimeError !== 'function') return;
    try {
      onRuntimeError(component);
    } catch {
      // Notify must never become an unhandled exception path.
    }
  });
}

/**
 * Format an IP host for use inside a URL authority.
 * @param {string} host
 * @returns {string}
 */
function formatUrlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * True only for the exact loopback literals allowed for management bind.
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopbackManagementHost(host) {
  return host === '127.0.0.1' || host === '::1';
}

/**
 * Expand IPv6 to 8 lowercase hextets for ULA classification.
 * @param {string} address
 * @returns {string[] | null}
 */
function expandIpv6Groups(address) {
  const bare = String(address).toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  const halves = bare.split('::');
  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else if (halves.length === 1) {
    groups = bare.split(':');
  } else {
    return null;
  }
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * RFC1918 IPv4 only (10/8, 172.16/12, 192.168/16). No loopback/link-local/public.
 * @param {string} host
 * @returns {boolean}
 */
function isRfc1918Ipv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

/**
 * IPv6 ULA only (fc00::/7). No loopback/link-local/public/wildcard.
 * @param {string} host
 * @returns {boolean}
 */
function isUlaIpv6(host) {
  const groups = expandIpv6Groups(host);
  if (!groups) return false;
  const first = Number.parseInt(groups[0], 16);
  if (!Number.isInteger(first)) return false;
  return (first & 0xfe00) === 0xfc00;
}

/**
 * True when host is an explicit private Agent IP literal (RFC1918 or ULA).
 * Hostnames, loopback, link-local, public and wildcards are rejected.
 * @param {unknown} host
 * @returns {boolean}
 */
export function isPrivateAgentHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const family = isIP(host);
  if (family === 4) return isRfc1918Ipv4(host);
  if (family === 6) return isUlaIpv6(host);
  return false;
}

/**
 * Strict port validation: integer in 0..65535 inclusive.
 * @param {unknown} port
 * @param {string} label
 * @returns {number}
 */
function assertPort(port, label) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} port must be an integer between 0 and 65535`);
  }
  return port;
}

/**
 * Parse a non-negative integer env value with a default.
 * @param {unknown} raw
 * @param {number} fallback
 * @param {string} label
 * @returns {number}
 */
function parseEnvPort(raw, fallback, label) {
  // undefined/null/empty/whitespace-only → unset; use fallback (never Number('') → 0).
  // Explicit string "0" remains a valid ephemeral port.
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${label} port must be an integer between 0 and 65535`);
  }
  return value;
}

/**
 * Start dual-listener controller: Agent HTTPS first, then loopback management.
 * On any failure after Agent listen, both servers are closed and status falls back.
 *
 * @param {{
 *   dataDir?: string,
 *   managementHost?: string,
 *   managementPort?: number,
 *   agentHost?: string,
 *   agentPort?: number,
 *   authToken?: string,
 *   readToken?: string,
 *   writeToken?: string,
 *   restoreRoot?: string,
 *   rateLimit?: object | null,
 *   auditRetention?: object | null,
 *   keychain?: { get: Function, set: Function, delete?: Function },
 *   acceptTlsFingerprintChange?: boolean,
 *   agentRateLimit?: { maxRequests: number, windowMs: number },
 *   listenServer?: typeof listen,
 *   managementServerFactory?: Function,
 *   agentServerFactory?: Function,
 *   onRuntimeError?: (component: 'agent' | 'management') => void,
 * }} [options]
 * @returns {Promise<{
 *   managementServer: import('node:http').Server,
 *   agentServer: import('node:https').Server,
 *   status: {
 *     managementHost: string,
 *     managementListening: boolean,
 *     agentBindConfigured: boolean,
 *     agentListening: boolean,
 *     tlsFingerprint: string,
 *   },
 *   close: () => Promise<void>,
 * }>}
 */
export async function startController({
  dataDir,
  managementHost = DEFAULT_MANAGEMENT_HOST,
  managementPort = DEFAULT_MANAGEMENT_PORT,
  agentHost,
  agentPort = DEFAULT_AGENT_PORT,
  authToken,
  readToken,
  writeToken,
  restoreRoot,
  rateLimit,
  auditRetention,
  keychain,
  acceptTlsFingerprintChange = false,
  agentRateLimit = DEFAULT_AGENT_RATE_LIMIT,
  listenServer = listen,
  managementServerFactory = createManagementServer,
  agentServerFactory = createAgentListener,
  onRuntimeError = () => {},
} = {}) {
  // Fail closed before any identity / Keychain / server side effects.
  // Do not rewrite a valid dataDir; only reject missing/blank (after trim) values.
  // keychain stays undefined until after pure config validation so illegal binds never
  // construct production KeychainStore (default params would evaluate too early).
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    throw new Error('dataDir is required');
  }
  if (!isLoopbackManagementHost(managementHost)) {
    throw new Error('management host must be loopback');
  }
  if (!isPrivateAgentHost(agentHost)) {
    throw new Error('agent host must be a private IP literal');
  }
  assertPort(managementPort, 'management');
  assertPort(agentPort, 'agent');

  // Structure-validate and build Agent limiter after pure config checks, before any
  // Keychain / TLS / registry side effects. null/false must fall back to default 60/min
  // (never disable). Construct once here; do not rebuild later.
  const agentLimiter = createFixedWindowRateLimiter(agentRateLimit)
    || createFixedWindowRateLimiter(DEFAULT_AGENT_RATE_LIMIT);

  const resolvedKeychain = keychain ?? new KeychainStore();
  const identityPort = agentPort === 0 ? DEFAULT_AGENT_PORT : agentPort;
  // Root-relative safe wiring: create/validate dataDir without recursive symlink follow;
  // tls/ is then created with the same no-follow segment walk.
  try {
    await ensureSafeDataRoot(dataDir);
    await ensureSafeRelativeDir(dataDir, 'tls');
  } catch (error) {
    if (error && error.message === 'dataDir is required') throw error;
    throw new Error('dataDir is required');
  }
  // Independent TlsIdentityStore constructor remains dataDir=tls directory for compatibility.
  const identityStore = new TlsIdentityStore({ dataDir: join(dataDir, 'tls'), keychain: resolvedKeychain });
  const identity = await identityStore.ensure({ host: agentHost, port: identityPort });
  const registry = new DeviceRegistry({ dataDir });

  try {
    await registry.verifyControllerFingerprint(identity.fingerprint);
  } catch (error) {
    // Only the exact boolean true may accept a fingerprint mismatch.
    if (error?.code !== 'device-tls-fingerprint-mismatch' || acceptTlsFingerprintChange !== true) {
      throw error;
    }
    await registry.acceptControllerFingerprint(identity.fingerprint);
  }

  const status = {
    managementHost,
    managementListening: false,
    agentBindConfigured: true,
    agentListening: false,
    tlsFingerprint: identity.fingerprint,
  };

  const agentServer = agentServerFactory({
    identity,
    registry,
    rateLimit: agentLimiter,
    onHeartbeat: ({ deviceId, hostname, remoteAddress }) => (
      recordHeartbeat(dataDir, deviceId, hostname, remoteAddress)
    ),
  });

  let managementServer;
  try {
    await listenServer(agentServer, agentPort, agentHost);
    status.agentListening = true;
    // Permanent handler after successful listen: late errors must not be unhandled.
    attachPostListenErrorHandler(agentServer, 'agent', status, onRuntimeError);

    const address = agentServer.address();
    const publicPort = typeof address === 'object' && address && Number.isInteger(address.port)
      ? address.port
      : agentPort;

    const deviceAdministration = {
      issueEnrollment: (request) => registry.issueEnrollment(request),
      revokeDevice: (deviceId) => registry.revokeDevice(deviceId),
      getStatus: async () => ({
        ...await registry.getStatus(),
        bindConfigured: status.agentBindConfigured,
        listening: status.agentListening,
        tlsFingerprintConfigured: Boolean(identity.fingerprint),
      }),
      agentUrl: `https://${formatUrlHost(agentHost)}:${publicPort}`,
      tlsFingerprint: identity.fingerprint,
    };

    managementServer = managementServerFactory({
      dataDir,
      authToken,
      readToken,
      writeToken,
      restoreRoot,
      rateLimit,
      auditRetention,
      deviceAdministration,
    });
    await listenServer(managementServer, managementPort, managementHost);
    status.managementListening = true;
    attachPostListenErrorHandler(managementServer, 'management', status, onRuntimeError);
  } catch (error) {
    await closeServer(managementServer);
    await closeServer(agentServer);
    status.managementListening = false;
    status.agentListening = false;
    throw error;
  }

  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    managementServer,
    agentServer,
    status,
    close() {
      if (!closing) {
        closing = Promise.all([
          closeServer(managementServer),
          closeServer(agentServer),
        ]).then(() => {
          status.managementListening = false;
          status.agentListening = false;
        });
      }
      return closing;
    },
  };
}

/**
 * Parse standalone environment into startController options.
 * Never logs or returns secret values beyond what env already holds for injection.
 * Management is always fixed to loopback; LINKE_AGENT_HOST is required.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{
 *   dataDir: string,
 *   managementHost: string,
 *   managementPort: number,
 *   agentHost: string,
 *   agentPort: number,
 *   authToken?: string,
 *   readToken?: string,
 *   writeToken?: string,
 *   restoreRoot?: string | null,
 *   rateLimit?: object | null,
 *   auditRetention?: object | null,
 *   acceptTlsFingerprintChange: boolean,
 * }}
 */
export function parseControllerEnv(env = process.env) {
  const agentHost = env.LINKE_AGENT_HOST;
  if (typeof agentHost !== 'string' || agentHost.trim() === '') {
    throw new Error('LINKE_AGENT_HOST is required');
  }
  const trimmedHost = agentHost.trim();
  if (!isPrivateAgentHost(trimmedHost)) {
    throw new Error('agent host must be a private IP literal');
  }

  const dataDirRaw = env.DATA_DIR;
  const dataDir = (typeof dataDirRaw === 'string' && dataDirRaw.trim())
    ? dataDirRaw.trim()
    : resolve(join(process.cwd(), 'data'));

  const managementPort = parseEnvPort(env.PORT, DEFAULT_MANAGEMENT_PORT, 'management');
  const agentPort = parseEnvPort(env.LINKE_AGENT_PORT, DEFAULT_AGENT_PORT, 'agent');
  const acceptTlsFingerprintChange = env.LINKE_ACCEPT_TLS_FINGERPRINT_CHANGE === 'enabled';

  return {
    dataDir,
    managementHost: DEFAULT_MANAGEMENT_HOST,
    managementPort,
    agentHost: trimmedHost,
    agentPort,
    authToken: env.LINKE_AUTH_TOKEN || env.LINKE_TOKEN,
    readToken: env.LINKE_READ_TOKEN,
    writeToken: env.LINKE_WRITE_TOKEN,
    restoreRoot: normalizeRestoreRoot(env.LINKE_RESTORE_ROOT),
    rateLimit: parseRateLimitPerMinute(env.LINKE_RATE_LIMIT_PER_MINUTE),
    auditRetention: parseAuditRetentionMaxEvents(env.LINKE_AUDIT_MAX_EVENTS),
    acceptTlsFingerprintChange,
  };
}

/**
 * Standalone runner with injectable deps for tests.
 * Logs only sanitized status; never prints paths, hosts, URLs, tokens or full fingerprints.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   start?: typeof startController,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 *   exit?: (code: number) => void,
 *   onSignal?: (signal: NodeJS.Signals, handler: () => void) => void,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function runControllerMain({
  env = process.env,
  start = startController,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
  exit = (code) => process.exit(code),
  onSignal = (signal, handler) => process.on(signal, handler),
} = {}) {
  let runtime;
  try {
    const options = parseControllerEnv(env);
    runtime = await start({
      ...options,
      onRuntimeError(component) {
        // Fixed strings only — never surface raw Error (paths/hosts/tokens/fingerprints).
        if (component === 'agent') {
          error('Linke controller runtime error: agent');
          return;
        }
        if (component === 'management') {
          error('Linke controller runtime error: management');
        }
      },
    });
  } catch {
    error('Linke controller failed to start');
    exit(1);
    return;
  }

  // Establish idempotent shutdown before signal registration so a partial
  // registration failure can still close once, and later signals never double-close.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    Promise.resolve()
      .then(() => runtime.close())
      .then(() => {
        exit(0);
      })
      .catch(() => {
        error('Linke controller failed to close');
        exit(1);
      });
  };

  try {
    onSignal('SIGINT', shutdown);
    onSignal('SIGTERM', shutdown);
  } catch {
    // Leave no running runtime if any signal registration fails.
    closing = true;
    try {
      await runtime.close();
    } catch {
      // swallow raw close errors; never surface paths/hosts/tokens/fingerprints
    }
    error('Linke controller failed to register shutdown handlers');
    exit(1);
    return;
  }

  // Only after full signal registration publish sanitized status.
  const fingerprintPrefix = typeof runtime.status?.tlsFingerprint === 'string'
    ? runtime.status.tlsFingerprint.slice(0, 12)
    : '';
  log(`Linke management listening: ${runtime.status.managementListening === true}`);
  log('Linke agent listener: enabled');
  if (fingerprintPrefix) {
    log(`Linke tls fingerprint: ${fingerprintPrefix}`);
  }
}

// Standalone entry: only when executed directly (import must not auto-start or register signals).
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runControllerMain().catch(() => {
    // Final rejection fallback: fixed sanitized string only — never raw Error.
    console.error('Linke controller failed');
    process.exit(1);
  });
}
