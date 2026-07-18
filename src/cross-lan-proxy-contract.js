/**
 * Cross-LAN proxy pure contract (T1.17 M1 only).
 *
 * --- honesty ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.17 M1 frozen Proxy Gold support surface + mutually exclusive
 *   failure buckets + typed configuration / failure claim classifiers only
 * [coverage] configuration-contract-only-not-runtime-proof
 * [not ready] Real CONNECT / dedicated credential-item verify / intercept
 *   detection / PAC runtime / Gold proxy I/O = NOT IMPLEMENTED
 * [flag] m1RuntimeReady = false
 *
 * Does not read URLs, credentials, Authorization headers, or secret material.
 * Outputs are closed decision labels / registered error codes / null only.
 */

import { ERROR_CODES } from './error-codes.js';

/** @type {ReadonlyArray<string>} */
const SUPPORTED_AUTH_SCHEMES = Object.freeze(['none', 'basic', 'bearer']);

/** @type {ReadonlyArray<string>} */
const UNSUPPORTED_DISCOVERY_MODES = Object.freeze(['pac', 'wpad']);

/** @type {ReadonlyArray<string>} */
const UNSUPPORTED_AUTH_SCHEMES = Object.freeze([
  'ntlm',
  'kerberos',
  'negotiate',
]);

/** @type {ReadonlyArray<string>} */
const SECRET_DESTINATIONS_FORBIDDEN = Object.freeze([
  'plain-file',
  'file-0600',
  'proxy-url-userinfo',
  'logs',
  'audit',
  'errors',
  'evidence',
]);

/** @type {Readonly<Record<string, string>>} */
const FAILURE_BUCKETS = Object.freeze({
  'proxy-auth-rejected': ERROR_CODES.PROXY_AUTH_FAILED,
  'proxy-connect-failed': ERROR_CODES.PROXY_CONNECT_FAILED,
  'unsupported-auth-challenge': ERROR_CODES.PROXY_UNSUPPORTED_AUTH,
  'pac-or-wpad-required': ERROR_CODES.PROXY_PAC_UNSUPPORTED,
  'proxy-chain-requested': ERROR_CODES.PROXY_CHAIN_UNSUPPORTED,
  'generic-tls-chain-or-pin-mismatch': ERROR_CODES.RELAY_TLS_PIN_MISMATCH,
  'tls-interception-detected': ERROR_CODES.PROXY_TLS_INTERCEPTED,
});

/**
 * Frozen Proxy Gold support policy (exact 27 keys).
 *
 * @type {Readonly<Record<string, unknown>>}
 */
export const CROSS_LAN_PROXY_POLICY = Object.freeze({
  scope: 'explicit-http-connect-only',
  supportedTunnelProtocol: 'http-connect',
  postTunnelTransport: 'wss-tls1.3-tcp443',
  supportedAuthSchemes: SUPPORTED_AUTH_SCHEMES,
  unauthenticatedProxyAllowed: true,
  supportedProxyHopCount: 1,
  proxyUrlUserinfoAllowed: false,
  authenticatedCredentialStorage: 'keychain-dedicated-item-claim-only',
  unauthenticatedCredentialStorage: 'not-applicable',
  plainFileCredentialStorageAllowed: false,
  file0600CredentialStorageAllowed: false,
  inlineCredentialStorageAllowed: false,
  fullTlsChainValidationRequired: true,
  spkiPinValidationRequired: true,
  unsupportedDiscoveryModes: UNSUPPORTED_DISCOVERY_MODES,
  unsupportedAuthSchemes: UNSUPPORTED_AUTH_SCHEMES,
  proxyChainSupported: false,
  tlsInterceptionSupported: false,
  installProxyCaAllowed: false,
  pinBypassAllowed: false,
  automaticDirectFallbackAllowed: false,
  secretDestinationsForbidden: SECRET_DESTINATIONS_FORBIDDEN,
  failureBuckets: FAILURE_BUCKETS,
  failureBucketSemantics: 'single-kind-mutually-exclusive',
  runtimeClaim: 'configuration-contract-only-not-runtime-proof',
  m1RuntimeReady: false,
  implementationStage: 'T1.17-M1-contract-only',
});

// ---------------------------------------------------------------------------
// Descriptor snapshot helpers — ownKeys once; getOwnPropertyDescriptor once
// per key; same descriptor validates + captures; no ordinary field get.
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const CONFIG_KEYS = Object.freeze([
  'discoveryMode',
  'tunnelProtocol',
  'authScheme',
  'proxyHopCount',
  'proxyUrlContainsUserinfo',
  'credentialStorage',
  'tlsChainValidationEnabled',
  'spkiPinValidationEnabled',
  'installProxyCaRequested',
  'directFallbackAllowed',
  'tlsInterceptionAllowed',
  'postTunnelTransport',
]);

/** @type {ReadonlySet<string>} */
const CONFIG_KEY_SET = Object.freeze(new Set(CONFIG_KEYS));

/** @type {ReadonlyArray<string>} */
const FAILURE_INPUT_KEYS = Object.freeze(['failureKind']);

/** @type {ReadonlySet<string>} */
const DISCOVERY_MODES = Object.freeze(
  new Set(['explicit', 'pac', 'wpad']),
);

/** @type {ReadonlySet<string>} */
const TUNNEL_PROTOCOLS = Object.freeze(new Set(['http-connect', 'other']));

/** @type {ReadonlySet<string>} */
const AUTH_SCHEMES = Object.freeze(
  new Set([
    'none',
    'basic',
    'bearer',
    'ntlm',
    'kerberos',
    'negotiate',
    'other',
  ]),
);

/** @type {ReadonlySet<string>} */
const CREDENTIAL_STORAGES = Object.freeze(
  new Set([
    'not-applicable',
    'keychain-dedicated-item',
    'plain-file',
    'file-0600',
    'inline-userinfo',
    'env',
    'other',
  ]),
);

/** @type {ReadonlySet<string>} */
const POST_TUNNEL_TRANSPORTS = Object.freeze(
  new Set(['wss-tls1.3-tcp443', 'other']),
);

/** @type {ReadonlySet<string>} */
const FAILURE_KIND_SET = Object.freeze(
  new Set(Object.keys(FAILURE_BUCKETS)),
);

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isOrdinaryOrNullPrototypeRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Snapshot exact ordinary/null-prototype record fields from descriptors only.
 * Reflect.ownKeys once; each key getOwnPropertyDescriptor exactly once.
 * Rejects symbols, non-enumerable, accessors, wrong key sets.
 *
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @returns {Record<string, unknown> | null}
 */
function snapshotExactRecord(value, expectedKeys) {
  try {
    if (!isOrdinaryOrNullPrototypeRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length) return null;

    /** @type {Set<string>} */
    const expected = new Set(expectedKeys);
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);

    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      if (!expected.has(key)) return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[key] = desc.value;
    }

    for (const k of expectedKeys) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBoolean(value) {
  return value === true || value === false;
}

/**
 * Type-check snapped configuration fields (enums / hop / booleans).
 * Unknown enum values → invalid (null). Known enum `other` is accepted here
 * and rejected later by policy priority (fail-closed, not fail-open).
 *
 * @param {Record<string, unknown>} fields
 * @returns {boolean}
 */
function isTypedConfigFields(fields) {
  if (!DISCOVERY_MODES.has(/** @type {string} */ (fields.discoveryMode))) {
    return false;
  }
  if (!TUNNEL_PROTOCOLS.has(/** @type {string} */ (fields.tunnelProtocol))) {
    return false;
  }
  if (!AUTH_SCHEMES.has(/** @type {string} */ (fields.authScheme))) {
    return false;
  }
  if (!isPositiveSafeInteger(fields.proxyHopCount)) return false;
  if (!isBoolean(fields.proxyUrlContainsUserinfo)) return false;
  if (
    !CREDENTIAL_STORAGES.has(/** @type {string} */ (fields.credentialStorage))
  ) {
    return false;
  }
  if (!isBoolean(fields.tlsChainValidationEnabled)) return false;
  if (!isBoolean(fields.spkiPinValidationEnabled)) return false;
  if (!isBoolean(fields.installProxyCaRequested)) return false;
  if (!isBoolean(fields.directFallbackAllowed)) return false;
  if (!isBoolean(fields.tlsInterceptionAllowed)) return false;
  if (
    !POST_TUNNEL_TRANSPORTS.has(
      /** @type {string} */ (fields.postTunnelTransport),
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Pure configuration decision classifier (total / no-throw).
 * Returns a closed decision label. `within-contract-scope` is a typed
 * configuration claim only — not URL parse, credential-item proof, or
 * runtime ready.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function classifyCrossLanProxyConfigurationDecision(input) {
  try {
    const fields = snapshotExactRecord(input, CONFIG_KEYS);
    if (fields === null) return 'invalid-input';
    // Guard against accidental key-set drift (exact set already enforced).
    for (const k of Object.keys(fields)) {
      if (!CONFIG_KEY_SET.has(k)) return 'invalid-input';
    }
    if (!isTypedConfigFields(fields)) return 'invalid-input';

    const discoveryMode = /** @type {string} */ (fields.discoveryMode);
    if (discoveryMode === 'pac' || discoveryMode === 'wpad') {
      return 'rejected-pac-wpad';
    }

    const tunnelProtocol = /** @type {string} */ (fields.tunnelProtocol);
    if (tunnelProtocol !== 'http-connect') {
      return 'rejected-tunnel-protocol';
    }

    const authScheme = /** @type {string} */ (fields.authScheme);
    if (
      authScheme === 'ntlm' ||
      authScheme === 'kerberos' ||
      authScheme === 'negotiate' ||
      authScheme === 'other'
    ) {
      return 'rejected-unsupported-auth';
    }

    const hop = /** @type {number} */ (fields.proxyHopCount);
    if (hop !== 1) return 'rejected-proxy-chain';

    if (fields.proxyUrlContainsUserinfo === true) {
      return 'rejected-userinfo-embedded';
    }

    const storage = /** @type {string} */ (fields.credentialStorage);
    if (authScheme === 'none') {
      if (storage !== 'not-applicable') return 'rejected-credential-storage';
    } else if (authScheme === 'basic' || authScheme === 'bearer') {
      if (storage !== 'keychain-dedicated-item') {
        return 'rejected-credential-storage';
      }
    } else {
      return 'invalid-input';
    }

    if (fields.installProxyCaRequested === true) {
      return 'rejected-proxy-ca-install';
    }

    if (
      fields.tlsChainValidationEnabled === false ||
      fields.spkiPinValidationEnabled === false
    ) {
      return 'rejected-pin-bypass';
    }

    if (fields.tlsInterceptionAllowed === true) {
      return 'rejected-tls-intercept';
    }

    if (fields.directFallbackAllowed === true) {
      return 'rejected-direct-fallback';
    }

    const post = /** @type {string} */ (fields.postTunnelTransport);
    if (post !== 'wss-tls1.3-tcp443') {
      return 'rejected-post-tunnel-transport';
    }

    return 'within-contract-scope';
  } catch {
    return 'invalid-input';
  }
}

/**
 * Pure failure kind → registered ERROR_CODES mapper (total / no-throw).
 * Input is a mutually exclusive caller claim, not a multi-boolean evidence
 * detector. Invalid / unknown shape → null.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function classifyCrossLanProxyFailure(input) {
  try {
    const fields = snapshotExactRecord(input, FAILURE_INPUT_KEYS);
    if (fields === null) return null;
    const kind = fields.failureKind;
    if (typeof kind !== 'string') return null;
    if (!FAILURE_KIND_SET.has(kind)) return null;
    return FAILURE_BUCKETS[kind] ?? null;
  } catch {
    return null;
  }
}
