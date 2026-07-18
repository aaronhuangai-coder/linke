/**
 * Honesty scope: T1.17 M1 pure contract only.
 * T1.0 Noise library gate = BLOCKED (not M1 crypto PASS).
 * Configuration / failure classifiers are claim-label maps only —
 * not URL parse, Keychain verify, CONNECT, 407, or TLS evidence detectors.
 * Real proxy runtime / Gold I/O = NOT IMPLEMENTED.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import * as proxy from '../src/cross-lan-proxy-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/cross-lan-proxy-contract.js');

const POLICY_KEYS = Object.freeze([
  'scope',
  'supportedTunnelProtocol',
  'postTunnelTransport',
  'supportedAuthSchemes',
  'unauthenticatedProxyAllowed',
  'supportedProxyHopCount',
  'proxyUrlUserinfoAllowed',
  'authenticatedCredentialStorage',
  'unauthenticatedCredentialStorage',
  'plainFileCredentialStorageAllowed',
  'file0600CredentialStorageAllowed',
  'inlineCredentialStorageAllowed',
  'fullTlsChainValidationRequired',
  'spkiPinValidationRequired',
  'unsupportedDiscoveryModes',
  'unsupportedAuthSchemes',
  'proxyChainSupported',
  'tlsInterceptionSupported',
  'installProxyCaAllowed',
  'pinBypassAllowed',
  'automaticDirectFallbackAllowed',
  'secretDestinationsForbidden',
  'failureBuckets',
  'failureBucketSemantics',
  'runtimeClaim',
  'm1RuntimeReady',
  'implementationStage',
]);

const FAILURE_KINDS = Object.freeze([
  'proxy-auth-rejected',
  'proxy-connect-failed',
  'unsupported-auth-challenge',
  'pac-or-wpad-required',
  'proxy-chain-requested',
  'generic-tls-chain-or-pin-mismatch',
  'tls-interception-detected',
]);

const EXPECTED_BUCKETS = Object.freeze({
  'proxy-auth-rejected': ERROR_CODES.PROXY_AUTH_FAILED,
  'proxy-connect-failed': ERROR_CODES.PROXY_CONNECT_FAILED,
  'unsupported-auth-challenge': ERROR_CODES.PROXY_UNSUPPORTED_AUTH,
  'pac-or-wpad-required': ERROR_CODES.PROXY_PAC_UNSUPPORTED,
  'proxy-chain-requested': ERROR_CODES.PROXY_CHAIN_UNSUPPORTED,
  'generic-tls-chain-or-pin-mismatch': ERROR_CODES.RELAY_TLS_PIN_MISMATCH,
  'tls-interception-detected': ERROR_CODES.PROXY_TLS_INTERCEPTED,
});

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

const DECISION_CLOSED = Object.freeze([
  'invalid-input',
  'rejected-pac-wpad',
  'rejected-tunnel-protocol',
  'rejected-unsupported-auth',
  'rejected-proxy-chain',
  'rejected-userinfo-embedded',
  'rejected-credential-storage',
  'rejected-proxy-ca-install',
  'rejected-pin-bypass',
  'rejected-tls-intercept',
  'rejected-direct-fallback',
  'rejected-post-tunnel-transport',
  'within-contract-scope',
]);

/** @param {Record<string, unknown>} [overrides] */
function validConfig(overrides = {}) {
  return {
    discoveryMode: 'explicit',
    tunnelProtocol: 'http-connect',
    authScheme: 'none',
    proxyHopCount: 1,
    proxyUrlContainsUserinfo: false,
    credentialStorage: 'not-applicable',
    tlsChainValidationEnabled: true,
    spkiPinValidationEnabled: true,
    installProxyCaRequested: false,
    directFallbackAllowed: false,
    tlsInterceptionAllowed: false,
    postTunnelTransport: 'wss-tls1.3-tcp443',
    ...overrides,
  };
}

/**
 * @param {object} target
 * @returns {{ proxy: object, descCounts: Record<string, number>, ownKeysCount: () => number }}
 */
function countingDescriptorProxy(target) {
  /** @type {Record<string, number>} */
  const descCounts = Object.create(null);
  let ownKeysCount = 0;
  const p = new Proxy(target, {
    ownKeys(t) {
      ownKeysCount += 1;
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === 'string') {
        descCounts[prop] = (descCounts[prop] || 0) + 1;
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  return { proxy: p, descCounts, ownKeysCount: () => ownKeysCount };
}

/**
 * First getOwnPropertyDescriptor for key returns firstValue; subsequent would be secondValue.
 * @param {object} target
 * @param {string} key
 * @param {unknown} firstValue
 * @param {unknown} secondValue
 */
function flipDescriptorProxy(target, key, firstValue, secondValue) {
  let hits = 0;
  const p = new Proxy(target, {
    getOwnPropertyDescriptor(t, prop) {
      if (prop === key) {
        hits += 1;
        return {
          value: hits === 1 ? firstValue : secondValue,
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  return { proxy: p, hits: () => hits };
}

/**
 * get trap returns valid; descriptor returns invalid (or reverse).
 * @param {object} target
 * @param {string} key
 * @param {'get-valid-desc-invalid' | 'get-invalid-desc-valid'} mode
 * @param {unknown} validValue
 * @param {unknown} invalidValue
 */
function getVsDescProxy(target, key, mode, validValue, invalidValue) {
  const p = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === key) {
        return mode === 'get-valid-desc-invalid' ? validValue : invalidValue;
      }
      return Reflect.get(t, prop, receiver);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === key) {
        return {
          value: mode === 'get-valid-desc-invalid' ? invalidValue : validValue,
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  return p;
}

describe('cross-lan proxy contract (T1.17 M1 pure contract)', () => {
  it('1) export surface exactly 3; policy exact 27 keys + deep freeze + registry maps', () => {
    assert.deepStrictEqual(Object.keys(proxy).sort(), [
      'CROSS_LAN_PROXY_POLICY',
      'classifyCrossLanProxyConfigurationDecision',
      'classifyCrossLanProxyFailure',
    ].sort());

    const p = proxy.CROSS_LAN_PROXY_POLICY;
    assert.ok(Object.isFrozen(p));
    assert.deepStrictEqual(Object.keys(p).sort(), [...POLICY_KEYS].sort());
    assert.strictEqual(Object.keys(p).length, 27);

    assert.strictEqual(p.scope, 'explicit-http-connect-only');
    assert.strictEqual(p.supportedTunnelProtocol, 'http-connect');
    assert.strictEqual(p.postTunnelTransport, 'wss-tls1.3-tcp443');
    assert.deepStrictEqual([...p.supportedAuthSchemes], ['none', 'basic', 'bearer']);
    assert.ok(Object.isFrozen(p.supportedAuthSchemes));
    assert.strictEqual(p.unauthenticatedProxyAllowed, true);
    assert.strictEqual(p.supportedProxyHopCount, 1);
    assert.strictEqual(p.proxyUrlUserinfoAllowed, false);
    assert.strictEqual(
      p.authenticatedCredentialStorage,
      'keychain-dedicated-item-claim-only',
    );
    assert.strictEqual(p.unauthenticatedCredentialStorage, 'not-applicable');
    assert.strictEqual(p.plainFileCredentialStorageAllowed, false);
    assert.strictEqual(p.file0600CredentialStorageAllowed, false);
    assert.strictEqual(p.inlineCredentialStorageAllowed, false);
    assert.strictEqual(p.fullTlsChainValidationRequired, true);
    assert.strictEqual(p.spkiPinValidationRequired, true);
    assert.deepStrictEqual([...p.unsupportedDiscoveryModes], ['pac', 'wpad']);
    assert.ok(Object.isFrozen(p.unsupportedDiscoveryModes));
    assert.deepStrictEqual([...p.unsupportedAuthSchemes], [
      'ntlm',
      'kerberos',
      'negotiate',
    ]);
    assert.ok(Object.isFrozen(p.unsupportedAuthSchemes));
    assert.strictEqual(p.proxyChainSupported, false);
    assert.strictEqual(p.tlsInterceptionSupported, false);
    assert.strictEqual(p.installProxyCaAllowed, false);
    assert.strictEqual(p.pinBypassAllowed, false);
    assert.strictEqual(p.automaticDirectFallbackAllowed, false);
    assert.deepStrictEqual([...p.secretDestinationsForbidden], [
      'plain-file',
      'file-0600',
      'proxy-url-userinfo',
      'logs',
      'audit',
      'errors',
      'evidence',
    ]);
    assert.ok(Object.isFrozen(p.secretDestinationsForbidden));

    assert.ok(Object.isFrozen(p.failureBuckets));
    assert.deepStrictEqual(Object.keys(p.failureBuckets).sort(), [
      ...FAILURE_KINDS,
    ].sort());
    assert.strictEqual(Object.keys(p.failureBuckets).length, 7);
    for (const kind of FAILURE_KINDS) {
      assert.strictEqual(p.failureBuckets[kind], EXPECTED_BUCKETS[kind]);
    }
    const values = Object.values(p.failureBuckets);
    assert.strictEqual(values.includes('relay-proxy-failed'), false);
    assert.strictEqual(new Set(values).size, 7);

    assert.strictEqual(p.failureBucketSemantics, 'single-kind-mutually-exclusive');
    assert.strictEqual(
      p.runtimeClaim,
      'configuration-contract-only-not-runtime-proof',
    );
    assert.strictEqual(p.m1RuntimeReady, false);
    assert.strictEqual(p.implementationStage, 'T1.17-M1-contract-only');
  });

  it('2) config happy paths: no-auth / Basic+Keychain / Bearer+Keychain → within-contract-scope', () => {
    const fn = proxy.classifyCrossLanProxyConfigurationDecision;
    assert.strictEqual(fn(validConfig()), 'within-contract-scope');
    assert.strictEqual(
      fn(
        validConfig({
          authScheme: 'basic',
          credentialStorage: 'keychain-dedicated-item',
        }),
      ),
      'within-contract-scope',
    );
    assert.strictEqual(
      fn(
        validConfig({
          authScheme: 'bearer',
          credentialStorage: 'keychain-dedicated-item',
        }),
      ),
      'within-contract-scope',
    );
    // null-prototype record accepted
    const nullProto = Object.assign(Object.create(null), validConfig());
    assert.strictEqual(fn(nullProto), 'within-contract-scope');
  });

  it('3) config rejections: each policy violation maps to closed decision label', () => {
    const fn = proxy.classifyCrossLanProxyConfigurationDecision;

    assert.strictEqual(fn(validConfig({ discoveryMode: 'pac' })), 'rejected-pac-wpad');
    assert.strictEqual(fn(validConfig({ discoveryMode: 'wpad' })), 'rejected-pac-wpad');
    assert.strictEqual(
      fn(validConfig({ tunnelProtocol: 'other' })),
      'rejected-tunnel-protocol',
    );
    for (const auth of ['ntlm', 'kerberos', 'negotiate', 'other']) {
      assert.strictEqual(
        fn(validConfig({ authScheme: auth })),
        'rejected-unsupported-auth',
        auth,
      );
    }
    assert.strictEqual(fn(validConfig({ proxyHopCount: 2 })), 'rejected-proxy-chain');
    assert.strictEqual(fn(validConfig({ proxyHopCount: 3 })), 'rejected-proxy-chain');
    assert.strictEqual(
      fn(validConfig({ proxyUrlContainsUserinfo: true })),
      'rejected-userinfo-embedded',
    );

    // none auth only not-applicable
    for (const storage of [
      'keychain-dedicated-item',
      'plain-file',
      'file-0600',
      'inline-userinfo',
      'env',
      'other',
    ]) {
      assert.strictEqual(
        fn(validConfig({ authScheme: 'none', credentialStorage: storage })),
        'rejected-credential-storage',
        `none+${storage}`,
      );
    }
    // basic/bearer only keychain-dedicated-item
    for (const auth of ['basic', 'bearer']) {
      for (const storage of [
        'not-applicable',
        'plain-file',
        'file-0600',
        'inline-userinfo',
        'env',
        'other',
      ]) {
        assert.strictEqual(
          fn(validConfig({ authScheme: auth, credentialStorage: storage })),
          'rejected-credential-storage',
          `${auth}+${storage}`,
        );
      }
    }

    assert.strictEqual(
      fn(validConfig({ installProxyCaRequested: true })),
      'rejected-proxy-ca-install',
    );
    assert.strictEqual(
      fn(validConfig({ tlsChainValidationEnabled: false })),
      'rejected-pin-bypass',
    );
    assert.strictEqual(
      fn(validConfig({ spkiPinValidationEnabled: false })),
      'rejected-pin-bypass',
    );
    assert.strictEqual(
      fn(
        validConfig({
          tlsChainValidationEnabled: false,
          spkiPinValidationEnabled: false,
        }),
      ),
      'rejected-pin-bypass',
    );
    assert.strictEqual(
      fn(validConfig({ tlsInterceptionAllowed: true })),
      'rejected-tls-intercept',
    );
    assert.strictEqual(
      fn(validConfig({ directFallbackAllowed: true })),
      'rejected-direct-fallback',
    );
    assert.strictEqual(
      fn(validConfig({ postTunnelTransport: 'other' })),
      'rejected-post-tunnel-transport',
    );
  });

  it('4) config invalid shape/type/hostile → invalid-input (closed set, no throw)', () => {
    const fn = proxy.classifyCrossLanProxyConfigurationDecision;
    const cases = [
      null,
      undefined,
      1,
      'x',
      true,
      [],
      new Date(),
      class C {},
      Object.create(Object.create(null)), // non-null non-Object prototype chain
      { ...validConfig(), extra: true },
      (() => {
        const o = validConfig();
        delete o.discoveryMode;
        return o;
      })(),
      { ...validConfig(), proxyUrl: 'REDACTED-MUST-NOT-ECHO' },
      { ...validConfig(), credential: 'REDACTED-MUST-NOT-ECHO' },
      { ...validConfig(), authorization: 'REDACTED-MUST-NOT-ECHO' },
      { ...validConfig(), secret: 'REDACTED-MUST-NOT-ECHO' },
      validConfig({ discoveryMode: 'unknown' }),
      validConfig({ tunnelProtocol: 'socks5' }),
      validConfig({ authScheme: 'digest' }),
      validConfig({ credentialStorage: 'vault' }),
      validConfig({ postTunnelTransport: 'ws' }),
      validConfig({ proxyHopCount: '1' }),
      validConfig({ proxyHopCount: 0 }),
      validConfig({ proxyHopCount: -1 }),
      validConfig({ proxyHopCount: 1.5 }),
      validConfig({ proxyHopCount: Number.MAX_SAFE_INTEGER + 1 }),
      validConfig({ proxyUrlContainsUserinfo: 'false' }),
      validConfig({ tlsChainValidationEnabled: 1 }),
      validConfig({ spkiPinValidationEnabled: null }),
      validConfig({ installProxyCaRequested: 0 }),
      validConfig({ directFallbackAllowed: 'no' }),
      validConfig({ tlsInterceptionAllowed: undefined }),
    ];
    for (let i = 0; i < cases.length; i += 1) {
      const out = fn(cases[i]);
      assert.strictEqual(out, 'invalid-input', `invalid case #${i}`);
      assert.ok(DECISION_CLOSED.includes(out));
    }

    // symbol own key
    {
      const o = validConfig();
      Object.defineProperty(o, Symbol('s'), { value: 1, enumerable: true });
      assert.strictEqual(fn(o), 'invalid-input');
    }
    // non-enumerable
    {
      const o = validConfig();
      Object.defineProperty(o, 'hidden', {
        value: 1,
        enumerable: false,
      });
      assert.strictEqual(fn(o), 'invalid-input');
    }
    // accessor
    {
      const o = validConfig();
      Object.defineProperty(o, 'note', {
        get() {
          return 'x';
        },
        enumerable: true,
      });
      assert.strictEqual(fn(o), 'invalid-input');
    }
    // class instance
    {
      class C {
        constructor() {
          Object.assign(this, validConfig());
        }
      }
      assert.strictEqual(fn(new C()), 'invalid-input');
    }
    // throwing proxy
    {
      const throwProxy = new Proxy(validConfig(), {
        ownKeys() {
          throw new Error('ownKeys-trap-must-not-echo');
        },
      });
      assert.strictEqual(fn(throwProxy), 'invalid-input');
    }
    // revoked proxy
    {
      const { proxy: rev, revoke } = Proxy.revocable(validConfig(), {});
      revoke();
      assert.strictEqual(fn(rev), 'invalid-input');
    }
  });

  it('5) failure classifier: exact 7 maps; invalid → null; mutex key set', () => {
    const fn = proxy.classifyCrossLanProxyFailure;
    for (const kind of FAILURE_KINDS) {
      assert.strictEqual(fn({ failureKind: kind }), EXPECTED_BUCKETS[kind], kind);
    }
    // null prototype
    assert.strictEqual(
      fn(Object.assign(Object.create(null), { failureKind: 'proxy-connect-failed' })),
      ERROR_CODES.PROXY_CONNECT_FAILED,
    );

    const invalids = [
      null,
      undefined,
      {},
      { failureKind: 'unknown' },
      { failureKind: 'relay-proxy-failed' },
      { failureKind: FAILURE_KINDS[0], extra: true },
      { wrong: 'proxy-auth-rejected' },
      [],
      new Date(),
      { failureKind: 1 },
      { failureKind: null },
    ];
    for (const c of invalids) {
      assert.strictEqual(fn(c), null);
    }

    // symbol / nonenum / accessor / class / throw / revoked
    {
      const o = { failureKind: 'proxy-auth-rejected' };
      Object.defineProperty(o, Symbol('s'), { value: 1, enumerable: true });
      assert.strictEqual(fn(o), null);
    }
    {
      const o = { failureKind: 'proxy-auth-rejected' };
      Object.defineProperty(o, 'hidden', { value: 1, enumerable: false });
      assert.strictEqual(fn(o), null);
    }
    {
      const o = {};
      Object.defineProperty(o, 'failureKind', {
        get() {
          return 'proxy-auth-rejected';
        },
        enumerable: true,
      });
      assert.strictEqual(fn(o), null);
    }
    {
      class C {
        constructor() {
          this.failureKind = 'proxy-auth-rejected';
        }
      }
      assert.strictEqual(fn(new C()), null);
    }
    {
      const throwProxy = new Proxy(
        { failureKind: 'proxy-auth-rejected' },
        {
          ownKeys() {
            throw new Error('fail-trap');
          },
        },
      );
      assert.strictEqual(fn(throwProxy), null);
    }
    {
      const { proxy: rev, revoke } = Proxy.revocable(
        { failureKind: 'proxy-auth-rejected' },
        {},
      );
      revoke();
      assert.strictEqual(fn(rev), null);
    }

    // mutex: policy keys exact match failureBuckets
    assert.deepStrictEqual(
      Object.keys(proxy.CROSS_LAN_PROXY_POLICY.failureBuckets).sort(),
      [...FAILURE_KINDS].sort(),
    );
  });

  it('6) descriptor contract: count-once + get-vs-desc both ways + flip (config + failure)', () => {
    const cfg = proxy.classifyCrossLanProxyConfigurationDecision;
    const fail = proxy.classifyCrossLanProxyFailure;

    // config: each key descriptor exactly once; ownKeys once
    {
      const base = validConfig();
      const { proxy: p, descCounts, ownKeysCount } = countingDescriptorProxy(base);
      assert.strictEqual(cfg(p), 'within-contract-scope');
      assert.strictEqual(ownKeysCount(), 1);
      for (const key of CONFIG_KEYS) {
        assert.strictEqual(descCounts[key], 1, key);
      }
    }

    // failure: failureKind once
    {
      const base = { failureKind: 'proxy-auth-rejected' };
      const { proxy: p, descCounts, ownKeysCount } = countingDescriptorProxy(base);
      assert.strictEqual(fail(p), ERROR_CODES.PROXY_AUTH_FAILED);
      assert.strictEqual(ownKeysCount(), 1);
      assert.strictEqual(descCounts.failureKind, 1);
    }

    // get-vs-desc: get valid / desc invalid → invalid (config)
    {
      const p = getVsDescProxy(
        validConfig({ proxyHopCount: 1 }),
        'proxyHopCount',
        'get-valid-desc-invalid',
        1,
        0,
      );
      assert.strictEqual(cfg(p), 'invalid-input');
    }
    // get-vs-desc: get invalid / desc valid → accept desc (config)
    {
      const p = getVsDescProxy(
        validConfig({ proxyHopCount: 1 }),
        'proxyHopCount',
        'get-invalid-desc-valid',
        1,
        0,
      );
      assert.strictEqual(cfg(p), 'within-contract-scope');
    }

    // get-vs-desc both ways (failure)
    {
      const p = getVsDescProxy(
        { failureKind: 'proxy-auth-rejected' },
        'failureKind',
        'get-valid-desc-invalid',
        'proxy-auth-rejected',
        'not-a-kind',
      );
      assert.strictEqual(fail(p), null);
    }
    {
      const p = getVsDescProxy(
        { failureKind: 'proxy-auth-rejected' },
        'failureKind',
        'get-invalid-desc-valid',
        'proxy-auth-rejected',
        'not-a-kind',
      );
      assert.strictEqual(fail(p), ERROR_CODES.PROXY_AUTH_FAILED);
    }

    // flip: first invalid second would-be valid → reject; second never observed
    {
      const { proxy: p, hits } = flipDescriptorProxy(
        validConfig({ discoveryMode: 'explicit' }),
        'discoveryMode',
        'not-a-mode',
        'explicit',
      );
      assert.strictEqual(cfg(p), 'invalid-input');
      assert.strictEqual(hits(), 1);
    }
    {
      const { proxy: p, hits } = flipDescriptorProxy(
        { failureKind: 'proxy-connect-failed' },
        'failureKind',
        'not-a-kind',
        'proxy-connect-failed',
      );
      assert.strictEqual(fail(p), null);
      assert.strictEqual(hits(), 1);
    }
  });

  it('7) no secret echo; decision/failure outputs closed; static import boundary', () => {
    const cfg = proxy.classifyCrossLanProxyConfigurationDecision;
    const fail = proxy.classifyCrossLanProxyFailure;
    const SENTINEL = 'MUST-NOT-ECHO-sentinel-value-xyz';

    const out1 = cfg({
      ...validConfig(),
      proxyUrl: SENTINEL,
      credential: SENTINEL,
      authorization: SENTINEL,
    });
    assert.strictEqual(out1, 'invalid-input');
    assert.strictEqual(String(out1).includes(SENTINEL), false);

    const out2 = fail({ failureKind: SENTINEL });
    assert.strictEqual(out2, null);

    // closed decision set sample
    for (const d of DECISION_CLOSED) {
      assert.strictEqual(typeof d, 'string');
    }
    assert.ok(DECISION_CLOSED.includes(cfg(validConfig())));

    // static: only error-codes import; no I/O / crypto / network / logger modules
    const src = readFileSync(SRC, 'utf8');
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) || /\brequire\s*\(/.test(line));
    assert.strictEqual(importLines.length, 1);
    assert.match(importLines[0], /from\s+['"]\.\/error-codes\.js['"]/);
    assert.doesNotMatch(src, /from\s+['"]node:/);
    assert.doesNotMatch(src, /\brequire\s*\(/);
    assert.doesNotMatch(src, /node:(fs|net|tls|http|https|crypto|child_process)\b/);
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.doesNotMatch(src, /\b(writeFile|readFile|createWriteStream)\b/);
    assert.doesNotMatch(src, /\b(console\.(log|info|warn|error)|logger)\b/);
    // no Date construction / timer APIs (policy strings may contain "tls")
    assert.doesNotMatch(src, /\bnew\s+Date\b/);
    assert.doesNotMatch(src, /\bDate\.(now|parse|UTC)\b/);
    // no Keychain runtime API; policy token keychain-dedicated-item is allowed
    assert.doesNotMatch(src, /\b(SecItem|KeychainServices|keychain-store)\b/i);

    // honesty: not runtime ready / not A26 claim
    assert.strictEqual(proxy.CROSS_LAN_PROXY_POLICY.m1RuntimeReady, false);
    assert.doesNotMatch(src, /\bA26\b/);
    assert.match(src, /configuration-contract-only-not-runtime-proof/);
    assert.match(src, /T1\.17-M1-contract-only/);
  });
});
