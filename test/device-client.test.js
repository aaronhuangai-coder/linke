import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
import {
  DeviceCredentialStore,
  requestPinnedJson,
  requestPinnedBinary,
  enrollDevice,
  heartbeatDevice,
  rotateDeviceToken,
  abortUploadSession,
} from '../src/device-client.js';
import {
  runDeviceEnrollCommand,
  runDeviceHeartbeatCommand,
  runDeviceTokenRotateCommand,
  parseArgs,
  printUsage,
} from '../src/agent.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import { ERROR_CODES } from '../src/error-codes.js';

/** Track open HTTPS fixtures so tests always close listeners. */
const openServers = new Set();

/**
 * In-memory Keychain adapter. Never touches macOS Keychain.
 * @param {Map<string, string>} [map]
 */
function memoryKeychain(map = new Map()) {
  return {
    async get(id) {
      if (!map.has(id)) {
        const error = new Error('keychain-item-missing');
        error.code = 'keychain-item-missing';
        throw error;
      }
      return map.get(id);
    },
    async set(id, value) {
      map.set(id, value);
    },
    async delete(id) {
      return map.delete(id);
    },
  };
}

/**
 * In-memory DeviceCredentialStore for high-level client tests.
 * @param {Map<string, string>} [map]
 */
function memoryCredentialStore(map = new Map()) {
  return new DeviceCredentialStore({ keychain: memoryKeychain(map) });
}

/**
 * Write a fixed JSON response for HTTPS fixtures.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * Start a loopback self-signed HTTPS server with known cert fingerprint.
 * Uses synthetic OpenSSL certs only; never contacts the network outside localhost.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{ url: string, fingerprint: string, server: import('node:https').Server, close: () => Promise<void> }>}
 */
async function startHttpsFixture(handler) {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  const certificate = new X509Certificate(certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const server = https.createServer({ key: keyPem, cert: certPem }, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server);
  const { port } = server.address();
  return {
    url: `https://127.0.0.1:${port}`,
    fingerprint,
    server,
    close: () => new Promise((resolve, reject) => {
      openServers.delete(server);
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/**
 * Collect text of an error for leak assertions (message + stack + string form).
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (!error || typeof error !== 'object') return String(error);
  const err = /** @type {Error & { code?: string }} */ (error);
  return `${err}\n${err.message || ''}\n${err.stack || ''}\n${err.code || ''}`;
}

after(async () => {
  for (const server of [...openServers]) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  openServers.clear();
});

describe('DeviceCredentialStore', () => {
  it('derives account/item id as SHA-256 prefix without host, deviceId, or token', async () => {
    const map = new Map();
    const getCalls = [];
    const setCalls = [];
    const keychain = {
      async get(id) {
        getCalls.push(id);
        if (!map.has(id)) {
          const error = new Error('keychain-item-missing');
          error.code = 'keychain-item-missing';
          throw error;
        }
        return map.get(id);
      },
      async set(id, value) {
        setCalls.push({ id, value });
        map.set(id, value);
      },
    };
    const store = new DeviceCredentialStore({ keychain });
    const agentUrl = 'https://controller.invalid:3443';
    const deviceId = 'mac-alpha';
    const token = 'synthetic-device-token-value-32chars-min';
    const expectedId = `device-token.${createHash('sha256')
      .update(`${agentUrl}\0${deviceId}`)
      .digest('hex')
      .slice(0, 32)}`;

    await store.setToken(agentUrl, deviceId, token);
    assert.strictEqual(setCalls.length, 1);
    assert.strictEqual(setCalls[0].id, expectedId);
    assert.strictEqual(setCalls[0].value, token);
    assert.ok(!setCalls[0].id.includes('controller.invalid'));
    assert.ok(!setCalls[0].id.includes(deviceId));
    assert.ok(!setCalls[0].id.includes(token));
    assert.ok(!setCalls[0].id.includes(agentUrl));
    assert.match(setCalls[0].id, /^device-token\.[0-9a-f]{32}$/);

    const got = await store.getToken(agentUrl, deviceId);
    assert.strictEqual(got, token);
    assert.deepStrictEqual(getCalls, [expectedId]);
  });

  it('propagates keychain get/set errors without rewriting codes', async () => {
    const missing = Object.assign(new Error('keychain-item-missing'), {
      code: 'keychain-item-missing',
    });
    const unavailable = Object.assign(new Error('keychain-unavailable'), {
      code: 'keychain-unavailable',
    });
    const storeGet = new DeviceCredentialStore({
      keychain: {
        async get() { throw missing; },
        async set() {},
      },
    });
    await assert.rejects(
      storeGet.getToken('https://controller.invalid:3443', 'mac-alpha'),
      (error) => error.code === 'keychain-item-missing',
    );
    const storeSet = new DeviceCredentialStore({
      keychain: {
        async get() { return 'x'; },
        async set() { throw unavailable; },
      },
    });
    await assert.rejects(
      storeSet.setToken('https://controller.invalid:3443', 'mac-alpha', 't'.repeat(32)),
      (error) => error.code === 'keychain-unavailable',
    );
  });

  it('requires a keychain adapter', () => {
    assert.throws(() => new DeviceCredentialStore({}), /keychain is required/);
  });
});

describe('requestPinnedJson URL and fingerprint gates', () => {
  it('rejects unsafe URL and fingerprint before opening a request', () => {
    for (const agentUrl of [
      'http://controller.local:3443',
      'https://user:pass@controller.local:3443',
      'https://controller.local:3443?x=1',
      'https://controller.local:3443#frag',
      'not-a-url',
      'https://',
    ]) {
      assert.throws(
        () => requestPinnedJson({
          agentUrl,
          path: '/agent/enroll',
          tlsFingerprint: 'a'.repeat(64),
          body: {},
        }),
        (error) => {
          const text = errorText(error);
          return error.code === 'device-tls-bind-invalid'
            && error.message === 'device-tls-bind-invalid'
            && !text.includes(String(agentUrl))
            && !text.includes('user:pass')
            && !text.includes('controller.local');
        },
      );
    }
    for (const tlsFingerprint of [undefined, '', 'aa:bb', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      assert.throws(
        () => requestPinnedJson({
          agentUrl: 'https://controller.invalid:3443',
          path: '/agent/enroll',
          tlsFingerprint,
          body: {},
        }),
        (error) => error.code === 'device-tls-fingerprint-mismatch'
          && error.message === 'device-tls-fingerprint-mismatch',
      );
    }
  });

  it('fail-closes unserializable bodies before any network open without leaking TypeError text', () => {
    // Unresolvable host + no DNS/network needed: throws before httpsRequest.
    const agentUrl = 'https://controller.invalid:3443';
    const circular = { marker: 'circular-body-field-must-not-leak' };
    circular.self = circular;

    for (const body of [1n, circular]) {
      assert.throws(
        () => requestPinnedJson({
          agentUrl,
          path: '/agent/enroll',
          tlsFingerprint: 'a'.repeat(64),
          body,
        }),
        (error) => {
          // Public surface only: name/code/message must be registered, never raw TypeError text.
          const publicText = `${error.name}\n${error.message}\n${error.code}`;
          return error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && error.message === 'device-request-invalid'
            && publicText === 'LinkeError\ndevice-request-invalid\ndevice-request-invalid'
            && !publicText.includes('TypeError')
            && !publicText.includes('BigInt')
            && !publicText.includes('circular-body-field-must-not-leak')
            && !publicText.includes('Converting circular structure')
            && !String(error.message).includes('Do not know how to serialize');
        },
      );
    }
  });

  it('fail-closes illegal timeoutMs before request creation without unhandled errors', () => {
    const agentUrl = 'https://controller.invalid:3443';
    const illegalTimeouts = [-1, 0, NaN, Infinity, -Infinity, 1.5, '1000', null, {}, 300_001];
    for (const timeoutMs of illegalTimeouts) {
      assert.throws(
        () => requestPinnedJson({
          agentUrl,
          path: '/agent/enroll',
          tlsFingerprint: 'a'.repeat(64),
          body: { probe: true },
          timeoutMs,
        }),
        (error) => {
          const publicText = `${error.name}\n${error.message}\n${error.code}`;
          return error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && error.message === 'device-request-invalid'
            && publicText === 'LinkeError\ndevice-request-invalid\ndevice-request-invalid'
            && !publicText.includes('RangeError')
            && !String(error.message).includes(String(timeoutMs));
        },
      );
    }
  });

  it('normalizes colon-separated and mixed-case fingerprints', async () => {
    let requestCount = 0;
    const server = await startHttpsFixture((req, res) => {
      requestCount += 1;
      sendJson(res, 200, { ok: true });
    });
    try {
      const colon = server.fingerprint.match(/.{1,2}/g).join(':').toUpperCase();
      const response = await requestPinnedJson({
        agentUrl: server.url,
        path: '/agent/ping',
        tlsFingerprint: colon,
        body: { hello: 'world' },
      });
      assert.deepStrictEqual(response, { ok: true });
      assert.strictEqual(requestCount, 1);
    } finally {
      await server.close();
    }
  });
});

describe('certificate pin before secret', () => {
  it('does not send enrollment code when the TLS fingerprint mismatches', async () => {
    let requestCount = 0;
    const server = await startHttpsFixture(() => {
      requestCount += 1;
    });
    try {
      await assert.rejects(
        enrollDevice({
          agentUrl: server.url,
          tlsFingerprint: '0'.repeat(64),
          deviceId: 'mac-alpha',
          enrollmentCode: 'must-not-cross-wrong-tls',
          credentialStore: memoryCredentialStore(),
        }),
        (error) => error.code === 'device-tls-fingerprint-mismatch',
      );
      assert.strictEqual(requestCount, 0);
    } finally {
      await server.close();
    }
  });

  it('does not write body until peer certificate pin succeeds', async () => {
    let sawBody = false;
    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => {
        sawBody = true;
        chunks.push(chunk);
      });
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        assert.ok(body.includes('"deviceId"'));
        sendJson(res, 201, {
          deviceId: 'mac-alpha',
          deviceToken: 't'.repeat(43),
          protocolVersion: 2,
        });
      });
    });
    try {
      await assert.rejects(
        enrollDevice({
          agentUrl: server.url,
          tlsFingerprint: 'f'.repeat(64),
          deviceId: 'mac-alpha',
          enrollmentCode: 'secret-must-not-arrive',
          credentialStore: memoryCredentialStore(),
        }),
        (error) => error.code === 'device-tls-fingerprint-mismatch',
      );
      assert.strictEqual(sawBody, false);

      const credentialStore = memoryCredentialStore();
      const result = await enrollDevice({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        enrollmentCode: 'ok-code',
        credentialStore,
      });
      assert.strictEqual(result.enrolled, true);
      assert.strictEqual(sawBody, true);
    } finally {
      await server.close();
    }
  });
});

describe('enrollDevice', () => {
  it('stores the returned token in Keychain and never returns it to the caller', async () => {
    const credentialStore = memoryCredentialStore();
    // Synthetic 43-char token (server format); plan sample was shorter than min length gate.
    const endpointToken = 'endpoint-secret-token-padded-to-43-chars!!';
    assert.ok(endpointToken.length >= 32);
    const server = await startHttpsFixture((req, res) => {
      sendJson(res, 201, {
        deviceId: 'mac-alpha',
        deviceToken: endpointToken,
        protocolVersion: 2,
      });
    });
    try {
      const result = await enrollDevice({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        enrollmentCode: 'single-use-code',
        credentialStore,
      });
      assert.deepStrictEqual(result, {
        deviceId: 'mac-alpha',
        enrolled: true,
        protocolVersion: 2,
      });
      assert.strictEqual(
        await credentialStore.getToken(server.url, 'mac-alpha'),
        endpointToken,
      );
      assert.ok(!JSON.stringify(result).includes(endpointToken));
      assert.ok(!JSON.stringify(result).includes('endpoint-secret-token'));
      assert.ok(!JSON.stringify(result).includes('single-use-code'));
    } finally {
      await server.close();
    }
  });

  it('rejects incomplete enrollment responses before writing Keychain', async () => {
    const cases = [
      { deviceId: 'other', deviceToken: 't'.repeat(43), protocolVersion: 2 },
      { deviceId: 'mac-alpha', deviceToken: 'short', protocolVersion: 2 },
      { deviceId: 'mac-alpha', deviceToken: 't'.repeat(43), protocolVersion: 1 },
      { deviceId: 'mac-alpha', protocolVersion: 2 },
    ];
    for (const payload of cases) {
      const map = new Map();
      const credentialStore = memoryCredentialStore(map);
      const server = await startHttpsFixture((req, res) => {
        sendJson(res, 201, payload);
      });
      try {
        await assert.rejects(
          enrollDevice({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: 'mac-alpha',
            enrollmentCode: 'code',
            credentialStore,
          }),
          (error) => error.code === 'device-request-invalid',
        );
        assert.strictEqual(map.size, 0);
      } finally {
        await server.close();
      }
    }
  });

  it('rejects non-plain 2xx response shapes without Keychain write or TypeError leak', async () => {
    const shapes = [null, [], 'scalar-string', 42, true];
    for (const payload of shapes) {
      const map = new Map();
      let setCalls = 0;
      const credentialStore = {
        async getToken() { throw new Error('getToken must not run'); },
        async setToken() {
          setCalls += 1;
          map.set('written', true);
        },
      };
      const server = await startHttpsFixture((req, res) => {
        sendJson(res, 201, payload);
      });
      try {
        await assert.rejects(
          enrollDevice({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: 'mac-alpha',
            enrollmentCode: 'code',
            credentialStore,
          }),
          (error) => {
            const publicText = `${error.name}\n${error.message}\n${error.code}`;
            return error.name === 'LinkeError'
              && error.code === 'device-request-invalid'
              && error.message === 'device-request-invalid'
              && !publicText.includes('TypeError')
              && !publicText.includes('Cannot read properties');
          },
        );
        assert.strictEqual(setCalls, 0);
        assert.strictEqual(map.size, 0);
      } finally {
        await server.close();
      }
    }
  });

  it('rejects malformed credentialStore before network without raw TypeError', async () => {
    let requestCount = 0;
    const server = await startHttpsFixture(() => {
      requestCount += 1;
    });
    try {
      for (const credentialStore of [undefined, null, {}, { setToken: 'nope' }]) {
        await assert.rejects(
          enrollDevice({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: 'mac-alpha',
            enrollmentCode: 'code',
            credentialStore,
          }),
          (error) => error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && !String(error.message).includes('TypeError'),
        );
      }
      assert.strictEqual(requestCount, 0);
    } finally {
      await server.close();
    }
  });
});

describe('heartbeatDevice', () => {
  it('reads token only from credential store and returns no token', async () => {
    const credentialStore = memoryCredentialStore();
    const server = await startHttpsFixture((req, res) => {
      assert.match(req.headers.authorization || '', /^Bearer /);
      sendJson(res, 200, { deviceId: 'mac-alpha', accepted: true });
    });
    try {
      await credentialStore.setToken(server.url, 'mac-alpha', 'hb-token-secret-value');
      const result = await heartbeatDevice({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        hostname: 'host-a',
        credentialStore,
      });
      assert.deepStrictEqual(result, { deviceId: 'mac-alpha', accepted: true });
      assert.ok(!JSON.stringify(result).includes('hb-token-secret-value'));
    } finally {
      await server.close();
    }
  });

  it('fails closed before request when token is missing', async () => {
    let requestCount = 0;
    const server = await startHttpsFixture(() => {
      requestCount += 1;
    });
    try {
      await assert.rejects(
        heartbeatDevice({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: 'mac-alpha',
          hostname: 'host-a',
          credentialStore: memoryCredentialStore(),
        }),
        (error) => error.code === 'keychain-item-missing'
          || error.code === 'device-token-invalid',
      );
      assert.strictEqual(requestCount, 0);
    } finally {
      await server.close();
    }
  });

  it('fails closed before request when token is empty', async () => {
    let requestCount = 0;
    const map = new Map();
    const store = new DeviceCredentialStore({
      keychain: {
        async get() { return ''; },
        async set(id, value) { map.set(id, value); },
      },
    });
    const server = await startHttpsFixture(() => {
      requestCount += 1;
    });
    try {
      await assert.rejects(
        heartbeatDevice({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: 'mac-alpha',
          hostname: 'host-a',
          credentialStore: store,
        }),
        (error) => error.code === 'device-token-invalid',
      );
      assert.strictEqual(requestCount, 0);
    } finally {
      await server.close();
    }
  });

  it('rejects non-plain 2xx heartbeat responses without TypeError leak', async () => {
    const shapes = [null, [], 'nope', 0];
    for (const payload of shapes) {
      const credentialStore = memoryCredentialStore();
      const server = await startHttpsFixture((req, res) => {
        sendJson(res, 200, payload);
      });
      try {
        await credentialStore.setToken(server.url, 'mac-alpha', 'hb-token-secret-value');
        await assert.rejects(
          heartbeatDevice({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: 'mac-alpha',
            hostname: 'host-a',
            credentialStore,
          }),
          (error) => error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && !String(error.message).includes('TypeError')
            && !String(error.message).includes('Cannot read properties'),
        );
      } finally {
        await server.close();
      }
    }
  });

  it('rejects malformed credentialStore before Keychain access', async () => {
    let getCalls = 0;
    await assert.rejects(
      heartbeatDevice({
        agentUrl: 'https://controller.invalid:3443',
        tlsFingerprint: 'a'.repeat(64),
        deviceId: 'mac-alpha',
        credentialStore: {
          getToken: 'not-a-function',
          setToken: async () => { getCalls += 1; },
        },
      }),
      (error) => error.code === 'device-request-invalid',
    );
    await assert.rejects(
      heartbeatDevice({
        agentUrl: 'https://controller.invalid:3443',
        tlsFingerprint: 'a'.repeat(64),
        deviceId: 'mac-alpha',
        credentialStore: null,
      }),
      (error) => error.code === 'device-request-invalid',
    );
    assert.strictEqual(getCalls, 0);
  });
});

describe('rotateDeviceToken', () => {
  it('keeps the old token if rotation fails and replaces it only after success', async () => {
    const credentialStore = memoryCredentialStore();
    let shouldFail = true;
    const server = await startHttpsFixture((req, res) => {
      if (req.url === '/agent/token/rotate' && shouldFail) {
        return sendJson(res, 503, { error: 'device-request-invalid' });
      }
      if (req.url === '/agent/token/rotate') {
        return sendJson(res, 200, { deviceId: 'mac-alpha', deviceToken: 'n'.repeat(43) });
      }
      if (req.url === '/agent/token/rotate/confirm') {
        return sendJson(res, 200, { deviceId: 'mac-alpha', rotated: true });
      }
      return sendJson(res, 404, { error: 'device-route-not-found' });
    });
    try {
      await credentialStore.setToken(server.url, 'mac-alpha', 'old-token');
      await assert.rejects(rotateDeviceToken({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        credentialStore,
      }));
      assert.strictEqual(await credentialStore.getToken(server.url, 'mac-alpha'), 'old-token');

      shouldFail = false;
      const result = await rotateDeviceToken({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        credentialStore,
      });
      assert.deepStrictEqual(result, { deviceId: 'mac-alpha', rotated: true });
      assert.strictEqual(await credentialStore.getToken(server.url, 'mac-alpha'), 'n'.repeat(43));
    } finally {
      await server.close();
    }
  });

  it('keeps pending token when confirm fails and never leaks tokens', async () => {
    const credentialStore = memoryCredentialStore();
    const server = await startHttpsFixture((req, res) => {
      if (req.url === '/agent/token/rotate') {
        return sendJson(res, 200, {
          deviceId: 'mac-alpha',
          deviceToken: 'pending-token-value-with-enough-length',
        });
      }
      if (req.url === '/agent/token/rotate/confirm') {
        return sendJson(res, 503, { error: 'device-request-invalid' });
      }
      return sendJson(res, 404, { error: 'device-route-not-found' });
    });
    try {
      await credentialStore.setToken(server.url, 'mac-alpha', 'old-token-original');
      await assert.rejects(
        rotateDeviceToken({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: 'mac-alpha',
          credentialStore,
        }),
        (error) => {
          const text = errorText(error);
          return error.code === 'device-request-invalid'
            && !text.includes('old-token-original')
            && !text.includes('pending-token-value-with-enough-length');
        },
      );
      assert.strictEqual(
        await credentialStore.getToken(server.url, 'mac-alpha'),
        'pending-token-value-with-enough-length',
      );
    } finally {
      await server.close();
    }
  });

  it('does not confirm when Keychain write of pending token fails', async () => {
    let confirmCount = 0;
    const server = await startHttpsFixture((req, res) => {
      if (req.url === '/agent/token/rotate') {
        return sendJson(res, 200, {
          deviceId: 'mac-alpha',
          deviceToken: 'p'.repeat(43),
        });
      }
      if (req.url === '/agent/token/rotate/confirm') {
        confirmCount += 1;
        return sendJson(res, 200, { deviceId: 'mac-alpha', rotated: true });
      }
      return sendJson(res, 404, { error: 'device-route-not-found' });
    });
    const map = new Map();
    const itemId = `device-token.${createHash('sha256')
      .update(`${server.url}\0mac-alpha`)
      .digest('hex')
      .slice(0, 32)}`;
    map.set(itemId, 'old-token');
    const store = new DeviceCredentialStore({
      keychain: {
        async get(id) {
          if (!map.has(id)) {
            const error = new Error('keychain-item-missing');
            error.code = 'keychain-item-missing';
            throw error;
          }
          return map.get(id);
        },
        async set(id, value) {
          if (value === 'p'.repeat(43)) {
            const error = new Error('keychain-unavailable');
            error.code = 'keychain-unavailable';
            throw error;
          }
          map.set(id, value);
        },
      },
    });
    try {
      await assert.rejects(
        rotateDeviceToken({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: 'mac-alpha',
          credentialStore: store,
        }),
        (error) => error.code === 'keychain-unavailable',
      );
      assert.strictEqual(confirmCount, 0);
      assert.strictEqual(map.get(itemId), 'old-token');
    } finally {
      await server.close();
    }
  });

  it('rejects non-plain rotate begin responses without set/confirm', async () => {
    const shapes = [null, [], 'token-string', 7];
    for (const payload of shapes) {
      let setCalls = 0;
      let confirmCount = 0;
      const map = new Map();
      const server = await startHttpsFixture((req, res) => {
        if (req.url === '/agent/token/rotate') {
          return sendJson(res, 200, payload);
        }
        if (req.url === '/agent/token/rotate/confirm') {
          confirmCount += 1;
          return sendJson(res, 200, { deviceId: 'mac-alpha', rotated: true });
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
      const itemId = `device-token.${createHash('sha256')
        .update(`${server.url}\0mac-alpha`)
        .digest('hex')
        .slice(0, 32)}`;
      map.set(itemId, 'old-token-keep');
      const store = {
        async getToken() { return 'old-token-keep'; },
        async setToken() { setCalls += 1; },
      };
      try {
        await assert.rejects(
          rotateDeviceToken({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: 'mac-alpha',
            credentialStore: store,
          }),
          (error) => error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && !String(error.message).includes('TypeError'),
        );
        assert.strictEqual(setCalls, 0);
        assert.strictEqual(confirmCount, 0);
        assert.strictEqual(map.get(itemId), 'old-token-keep');
      } finally {
        await server.close();
      }
    }
  });

  it('rejects malformed credentialStore before Keychain get for rotate', async () => {
    let touched = 0;
    await assert.rejects(
      rotateDeviceToken({
        agentUrl: 'https://controller.invalid:3443',
        tlsFingerprint: 'b'.repeat(64),
        deviceId: 'mac-alpha',
        credentialStore: {
          getToken: undefined,
          setToken: async () => { touched += 1; },
        },
      }),
      (error) => error.code === 'device-request-invalid',
    );
    assert.strictEqual(touched, 0);
  });

  it('retries confirm with pending token after begin returns device-token-invalid', async () => {
    const credentialStore = memoryCredentialStore();
    const oldToken = 'old-rotation-token-value-32chars-min!!';
    const pendingToken = 'pending-rotation-token-value-32chars!!';
    /** @type {{ path: string, auth: string }[]} */
    const requests = [];
    let confirmAttempts = 0;

    const server = await startHttpsFixture((req, res) => {
      const auth = String(req.headers.authorization || '');
      requests.push({ path: req.url || '', auth });
      const bodyChunks = [];
      req.on('data', (chunk) => bodyChunks.push(chunk));
      req.on('end', () => {
        if (req.url === '/agent/token/rotate') {
          if (auth === `Bearer ${oldToken}`) {
            return sendJson(res, 200, {
              deviceId: 'mac-alpha',
              deviceToken: pendingToken,
            });
          }
          // Pending (or any non-current) token cannot begin rotation.
          return sendJson(res, 401, { error: ERROR_CODES.DEVICE_TOKEN_INVALID });
        }
        if (req.url === '/agent/token/rotate/confirm') {
          confirmAttempts += 1;
          if (confirmAttempts === 1) {
            // First confirm fails after begin success; pending remains in Keychain.
            return sendJson(res, 503, { error: ERROR_CODES.DEVICE_REQUEST_INVALID });
          }
          if (auth === `Bearer ${pendingToken}`) {
            return sendJson(res, 200, { deviceId: 'mac-alpha', rotated: true });
          }
          return sendJson(res, 401, { error: ERROR_CODES.DEVICE_TOKEN_INVALID });
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
    });

    try {
      await credentialStore.setToken(server.url, 'mac-alpha', oldToken);

      await assert.rejects(
        rotateDeviceToken({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: 'mac-alpha',
          credentialStore,
        }),
        (error) => error.code === 'device-request-invalid',
      );
      assert.strictEqual(
        await credentialStore.getToken(server.url, 'mac-alpha'),
        pendingToken,
      );

      const beforeSecond = requests.length;
      const result = await rotateDeviceToken({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        credentialStore,
      });
      assert.deepStrictEqual(result, { deviceId: 'mac-alpha', rotated: true });
      assert.strictEqual(
        await credentialStore.getToken(server.url, 'mac-alpha'),
        pendingToken,
      );
      assert.ok(!JSON.stringify(result).includes(pendingToken));
      assert.ok(!JSON.stringify(result).includes(oldToken));

      const secondCall = requests.slice(beforeSecond);
      assert.deepStrictEqual(
        secondCall.map((entry) => entry.path),
        ['/agent/token/rotate', '/agent/token/rotate/confirm'],
      );
      assert.strictEqual(secondCall[0].auth, `Bearer ${pendingToken}`);
      assert.strictEqual(secondCall[1].auth, `Bearer ${pendingToken}`);
      assert.strictEqual(confirmAttempts, 2);
    } finally {
      await server.close();
    }
  });

  it('does not attempt confirm recovery on non-token-invalid begin errors', async () => {
    const credentialStore = memoryCredentialStore();
    /** @type {string[]} */
    const paths = [];
    const server = await startHttpsFixture((req, res) => {
      paths.push(req.url || '');
      if (req.url === '/agent/token/rotate') {
        return sendJson(res, 403, { error: ERROR_CODES.DEVICE_REVOKED });
      }
      if (req.url === '/agent/token/rotate/confirm') {
        return sendJson(res, 200, { deviceId: 'mac-alpha', rotated: true });
      }
      return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
    });
    try {
      await credentialStore.setToken(server.url, 'mac-alpha', 'still-current-token-32chars-min!!');
      await assert.rejects(
        rotateDeviceToken({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: 'mac-alpha',
          credentialStore,
        }),
        (error) => error.code === 'device-revoked',
      );
      assert.deepStrictEqual(paths, ['/agent/token/rotate']);
      assert.strictEqual(
        await credentialStore.getToken(server.url, 'mac-alpha'),
        'still-current-token-32chars-min!!',
      );
    } finally {
      await server.close();
    }
  });
});

describe('requestPinnedJson error mapping and bounds', () => {
  it('maps non-2xx registered errors and fail-closes unknown codes or bad status', async () => {
    const server = await startHttpsFixture((req, res) => {
      if (req.url === '/agent/registered') {
        return sendJson(res, 403, { error: ERROR_CODES.DEVICE_REVOKED });
      }
      if (req.url === '/agent/unknown-code') {
        return sendJson(res, 500, { error: 'ENOENT /private/secret' });
      }
      if (req.url === '/agent/bad-status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // Force an unusual non-success via raw writeHead already sent as 200 —
        // use a synthetic path that returns 999 via writeHead.
        return undefined;
      }
      if (req.url === '/agent/status-999') {
        const data = JSON.stringify({ error: ERROR_CODES.DEVICE_REQUEST_INVALID });
        res.writeHead(999, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        });
        return res.end(data);
      }
      if (req.url === '/agent/status-199') {
        // 1xx is not a success for this client; must fail-closed.
        const data = JSON.stringify({ ok: true });
        res.writeHead(199, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        });
        return res.end(data);
      }
      if (req.url === '/agent/malformed') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': 5 });
        return res.end('{not');
      }
      return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
    });
    try {
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/registered',
          tlsFingerprint: server.fingerprint,
          body: {},
        }),
        (error) => error.code === 'device-revoked' && error.statusCode === 403,
      );
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/unknown-code',
          tlsFingerprint: server.fingerprint,
          body: {},
        }),
        (error) => {
          const text = errorText(error);
          return error.code === 'device-request-invalid'
            && !text.includes('ENOENT')
            && !text.includes('/private/secret');
        },
      );
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/status-999',
          tlsFingerprint: server.fingerprint,
          body: {},
        }),
        (error) => error.code === 'device-request-invalid',
      );
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/status-199',
          tlsFingerprint: server.fingerprint,
          body: {},
        }),
        (error) => error.code === 'device-request-invalid',
      );
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/malformed',
          tlsFingerprint: server.fingerprint,
          body: {},
        }),
        (error) => error.code === 'device-request-invalid',
      );
    } finally {
      await server.close();
    }
  });

  it('rejects oversized response bodies without leaking raw content', async () => {
    const server = await startHttpsFixture((req, res) => {
      const huge = `{"pad":"${'x'.repeat(70 * 1024)}"}`;
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(huge),
      });
      res.end(huge);
    });
    try {
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/enroll',
          tlsFingerprint: server.fingerprint,
          body: {},
        }),
        (error) => {
          const text = errorText(error);
          return error.code === 'device-request-invalid'
            && !text.includes('xxxx');
        },
      );
    } finally {
      await server.close();
    }
  });

  it('maps connection timeout to device-request-invalid without host leakage', async () => {
    // Hold TLS open but never complete the response after pin succeeds.
    const server = await startHttpsFixture((req, res) => {
      // intentionally never respond
      void req;
      void res;
    });
    try {
      await assert.rejects(
        requestPinnedJson({
          agentUrl: server.url,
          path: '/agent/enroll',
          tlsFingerprint: server.fingerprint,
          body: { deviceId: 'mac-alpha' },
          timeoutMs: 50,
        }),
        (error) => {
          const text = errorText(error);
          return error.code === 'device-request-invalid'
            && !text.includes('127.0.0.1')
            && !text.includes(String(server.url));
        },
      );
    } finally {
      await server.close();
    }
  });
});

describe('requestPinnedBinary (C7) + G0a requestPinnedJson regression', () => {
  it('G0a requestPinnedJson still posts JSON after pin without auth triad requirement', async () => {
    let sawAuth = false;
    let sawBody = false;
    const server = await startHttpsFixture((req, res) => {
      if (req.headers.authorization) sawAuth = true;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        sawBody = Buffer.concat(chunks).length > 0;
        sendJson(res, 200, { ok: true, via: 'json' });
      });
    });
    try {
      const response = await requestPinnedJson({
        agentUrl: server.url,
        path: '/agent/ping',
        tlsFingerprint: server.fingerprint,
        body: { hello: 'g0a' },
      });
      assert.deepStrictEqual(response, { ok: true, via: 'json' });
      assert.strictEqual(sawBody, true);
      // G0a path may omit Authorization when no token is provided.
      assert.strictEqual(sawAuth, false);
    } finally {
      await server.close();
    }
  });

  it('pin failure never writes binary body; success sends mandatory auth triad exactly once', async () => {
    let sawBody = false;
    /** @type {Record<string, string|string[]|undefined>} */
    let lastHeaders = {};
    const server = await startHttpsFixture((req, res) => {
      lastHeaders = req.headers;
      const chunks = [];
      req.on('data', (c) => {
        sawBody = true;
        chunks.push(c);
      });
      req.on('end', () => {
        sendJson(res, 200, { acked: true });
      });
    });
    try {
      await assert.rejects(
        requestPinnedBinary({
          agentUrl: server.url,
          path: '/agent/upload/sessions/x/chunks',
          tlsFingerprint: 'f'.repeat(64),
          method: 'POST',
          token: 'tok-must-not-arrive-on-wrong-pin',
          deviceId: 'mac-alpha',
          body: Buffer.from('secret-binary-payload'),
          bodyMode: 'buffer',
        }),
        (error) => error.code === 'device-tls-fingerprint-mismatch'
          && !errorText(error).includes('secret-binary-payload')
          && !errorText(error).includes('tok-must-not-arrive'),
      );
      assert.strictEqual(sawBody, false);

      sawBody = false;
      const response = await requestPinnedBinary({
        agentUrl: server.url,
        path: '/agent/upload/sessions/x/chunks',
        tlsFingerprint: server.fingerprint,
        method: 'POST',
        token: 'device-token-fixture-value',
        deviceId: 'mac-alpha',
        body: Buffer.from('ok-binary'),
        bodyMode: 'buffer',
      });
      assert.deepStrictEqual(response, { acked: true });
      assert.strictEqual(sawBody, true);
      assert.strictEqual(lastHeaders.authorization, 'Bearer device-token-fixture-value');
      assert.strictEqual(lastHeaders['x-linke-device-id'], 'mac-alpha');
      assert.strictEqual(lastHeaders['x-linke-protocol-version'], '2');
    } finally {
      await server.close();
    }
  });

  it('AbortSignal settles as device-request-invalid without raw AbortError leak', async () => {
    const server = await startHttpsFixture((req, res) => {
      // never complete
      void req;
      void res;
    });
    const controller = new AbortController();
    try {
      const pending = requestPinnedBinary({
        agentUrl: server.url,
        path: '/agent/upload/sessions/u1',
        tlsFingerprint: server.fingerprint,
        method: 'GET',
        token: 't'.repeat(32),
        deviceId: 'mac-alpha',
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      controller.abort();
      await assert.rejects(
        pending,
        (error) => {
          const text = errorText(error);
          return error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && !text.includes('AbortError')
            && !text.includes('This operation was aborted');
        },
      );
    } finally {
      await server.close();
    }
  });

  it('abortUploadSession posts abort path with mandatory triad', async () => {
    /** @type {string | undefined} */
    let method;
    /** @type {string | undefined} */
    let url;
    /** @type {Record<string, string|string[]|undefined>} */
    let headers = {};
    const server = await startHttpsFixture((req, res) => {
      method = req.method;
      url = req.url;
      headers = req.headers;
      sendJson(res, 200, {
        uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        deviceId: 'mac-alpha',
        status: 'aborted',
      });
    });
    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, 'mac-alpha', 'abort-token-value-32chars-min!!');
    try {
      const result = await abortUploadSession({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: 'mac-alpha',
        uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        credentialStore,
      });
      assert.equal(method, 'POST');
      assert.equal(url, '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-000000000001/abort');
      assert.equal(headers.authorization, 'Bearer abort-token-value-32chars-min!!');
      assert.equal(headers['x-linke-device-id'], 'mac-alpha');
      assert.equal(headers['x-linke-protocol-version'], '2');
      assert.equal(result.status, 'aborted');
      assert.equal(result.deviceId, 'mac-alpha');
    } finally {
      await server.close();
    }
  });

  it('2xx empty / array / malformed JSON are non-retry wire-shape invalid (statusCode 400)', async () => {
    const cases = [
      { label: 'empty', write: (res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 0 }); res.end(); } },
      { label: 'array', write: (res) => sendJson(res, 200, ['not-object']) },
      { label: 'malformed', write: (res) => {
        const data = '{not-json';
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        });
        res.end(data);
      } },
    ];
    for (const c of cases) {
      const server = await startHttpsFixture((req, res) => {
        void req;
        c.write(res);
      });
      try {
        await assert.rejects(
          requestPinnedBinary({
            agentUrl: server.url,
            path: '/agent/upload/sessions/x',
            tlsFingerprint: server.fingerprint,
            method: 'GET',
            token: 't'.repeat(32),
            deviceId: 'mac-alpha',
          }),
          (error) => error.name === 'LinkeError'
            && error.code === 'device-request-invalid'
            && error.statusCode === 400,
          c.label,
        );
      } finally {
        await server.close();
      }
    }
  });

  it('abort 2xx empty or wrong status fail-closes non-retry', async () => {
    let n = 0;
    const server = await startHttpsFixture((req, res) => {
      n += 1;
      if (n === 1) {
        return sendJson(res, 200, {});
      }
      return sendJson(res, 200, {
        uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        deviceId: 'mac-alpha',
        status: 'receiving',
      });
    });
    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, 'mac-alpha', 'abort-token-value-32chars-min!!');
    try {
      for (let i = 0; i < 2; i += 1) {
        await assert.rejects(
          abortUploadSession({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: 'mac-alpha',
            uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
            credentialStore,
          }),
          (error) => error.code === 'device-request-invalid' && error.statusCode === 400,
        );
      }
    } finally {
      await server.close();
    }
  });
});

describe('secret-safe device CLI', () => {
  it('CLI reads enrollment code from stdin and never prints code or token', async () => {
    const output = [];
    const result = await runDeviceEnrollCommand({
      server: 'https://controller.invalid:3443',
      device: 'mac-alpha',
      'tls-fingerprint': 'a'.repeat(64),
      'enrollment-code-stdin': true,
    }, {
      input: Readable.from(['cli-one-time-code\n']),
      credentialStore: memoryCredentialStore(),
      enroll: async (options) => {
        assert.strictEqual(options.enrollmentCode, 'cli-one-time-code');
        return { deviceId: 'mac-alpha', enrolled: true, protocolVersion: 2 };
      },
      writeOutput: (value) => output.push(JSON.stringify(value)),
    });
    assert.deepStrictEqual(result, {
      deviceId: 'mac-alpha',
      enrolled: true,
      protocolVersion: 2,
    });
    assert.doesNotMatch(output.join(''), /cli-one-time-code|endpoint-secret-token/);
  });

  it('rejects argv secrets and empty enrollment stdin before Keychain access', async () => {
    const forbiddenArgs = {
      server: 'https://controller.invalid:3443',
      device: 'mac-alpha',
      'tls-fingerprint': 'a'.repeat(64),
      'enrollment-code-stdin': true,
      'enrollment-code': 'argv-secret',
    };
    await assert.rejects(
      runDeviceEnrollCommand(forbiddenArgs, {
        input: Readable.from(['stdin-secret\n']),
      }),
      /accepts secrets from stdin and Keychain only/,
    );
    await assert.rejects(
      runDeviceEnrollCommand({
        server: 'https://controller.invalid:3443',
        device: 'mac-alpha',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
        token: 'argv-token',
      }, {
        input: Readable.from(['stdin-secret\n']),
      }),
      /accepts secrets from stdin and Keychain only/,
    );
    await assert.rejects(
      runDeviceEnrollCommand({
        server: 'https://controller.invalid:3443',
        device: 'mac-alpha',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
      }, {
        input: Readable.from([]),
        credentialStore: memoryCredentialStore(),
      }),
      /stdin secret is invalid/,
    );
    await assert.rejects(
      runDeviceEnrollCommand({
        server: 'https://controller.invalid:3443',
        device: 'mac-alpha',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
      }, {
        input: Readable.from(['x'.repeat(4_097)]),
        credentialStore: memoryCredentialStore(),
      }),
      /stdin secret is invalid/,
    );
    await assert.rejects(
      runDeviceEnrollCommand({
        server: 'https://controller.invalid:3443',
        device: 'mac-alpha',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
      }, {
        input: Readable.from(['line-one\nline-two\n']),
        credentialStore: memoryCredentialStore(),
      }),
      /stdin secret is invalid/,
    );
    await assert.rejects(
      runDeviceHeartbeatCommand({ token: 'argv-secret' }),
      /reads the token from Keychain/,
    );
    await assert.rejects(
      runDeviceTokenRotateCommand({ token: 'argv-secret' }),
      /reads the token from Keychain/,
    );
  });

  it('heartbeat and rotate CLI pass Keychain store and never accept argv token', async () => {
    const output = [];
    const credentialStore = memoryCredentialStore();
    await runDeviceHeartbeatCommand({
      server: 'https://controller.invalid:3443',
      device: 'mac-alpha',
      'tls-fingerprint': 'b'.repeat(64),
      hostname: 'desk',
    }, {
      credentialStore,
      heartbeat: async (options) => {
        assert.strictEqual(options.credentialStore, credentialStore);
        assert.strictEqual(options.agentUrl, 'https://controller.invalid:3443');
        assert.strictEqual(options.deviceId, 'mac-alpha');
        assert.ok(!Object.prototype.hasOwnProperty.call(options, 'token'));
        return { deviceId: 'mac-alpha', accepted: true };
      },
      writeOutput: (value) => output.push(JSON.stringify(value)),
    });
    await runDeviceTokenRotateCommand({
      server: 'https://controller.invalid:3443',
      device: 'mac-alpha',
      'tls-fingerprint': 'b'.repeat(64),
    }, {
      credentialStore,
      rotate: async (options) => {
        assert.strictEqual(options.credentialStore, credentialStore);
        assert.ok(!Object.prototype.hasOwnProperty.call(options, 'token'));
        return { deviceId: 'mac-alpha', rotated: true };
      },
      writeOutput: (value) => output.push(JSON.stringify(value)),
    });
    assert.doesNotMatch(output.join(''), /token|secret/i);
  });

  it('help text documents HTTPS URL, fingerprint, stdin code, and no CLI token secrets', () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      printUsage();
    } finally {
      console.log = original;
    }
    const help = lines.join('\n');
    assert.match(help, /device-enroll/);
    assert.match(help, /device-heartbeat/);
    assert.match(help, /device-token-rotate/);
    assert.match(help, /HTTPS/);
    assert.match(help, /tls-fingerprint/);
    assert.match(help, /64/);
    assert.match(help, /stdin/i);
    assert.match(help, /Keychain/i);
    assert.doesNotMatch(help, /--enrollment-code <code>/);
  });

  it('parseArgs still supports management --token without device command leakage', () => {
    const args = parseArgs(['backup', '--server', 'http://localhost:3000', '--token', 'mgmt-token']);
    assert.strictEqual(args.token, 'mgmt-token');
    assert.strictEqual(args._[0], 'backup');
  });

  it('validates public CLI args before stdin/Keychain/operation access', async () => {
    let stdinChunks = 0;
    let enrollCalls = 0;
    let keychainGets = 0;
    let keychainSets = 0;
    const trackingInput = {
      async *[Symbol.asyncIterator]() {
        stdinChunks += 1;
        yield 'must-not-be-read\n';
      },
    };
    const trackingStore = {
      async getToken() {
        keychainGets += 1;
        return 'token';
      },
      async setToken() {
        keychainSets += 1;
      },
    };

    // Missing device for enroll: no stdin iteration, no enroll, no Keychain.
    await assert.rejects(
      runDeviceEnrollCommand({
        server: 'https://controller.invalid:3443',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
      }, {
        input: trackingInput,
        credentialStore: trackingStore,
        enroll: async () => {
          enrollCalls += 1;
          return { deviceId: 'x', enrolled: true, protocolVersion: 2 };
        },
      }),
      (error) => {
        const msg = String(error.message);
        return /device command arguments are invalid/.test(msg)
          && !msg.includes('controller.invalid')
          && !msg.includes('must-not-be-read');
      },
    );
    assert.strictEqual(stdinChunks, 0);
    assert.strictEqual(enrollCalls, 0);
    assert.strictEqual(keychainGets, 0);
    assert.strictEqual(keychainSets, 0);

    // Empty server / missing fingerprint also fail closed before secret paths.
    await assert.rejects(
      runDeviceEnrollCommand({
        server: '',
        device: 'mac-alpha',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
      }, {
        input: trackingInput,
        credentialStore: trackingStore,
        enroll: async () => {
          enrollCalls += 1;
        },
      }),
      /device command arguments are invalid/,
    );
    assert.strictEqual(stdinChunks, 0);
    assert.strictEqual(enrollCalls, 0);

    let heartbeatCalls = 0;
    let rotateCalls = 0;
    await assert.rejects(
      runDeviceHeartbeatCommand({
        server: 'https://controller.invalid:3443',
        device: 'mac-alpha',
      }, {
        credentialStore: trackingStore,
        heartbeat: async () => {
          heartbeatCalls += 1;
          return { deviceId: 'mac-alpha', accepted: true };
        },
      }),
      /device command arguments are invalid/,
    );
    await assert.rejects(
      runDeviceTokenRotateCommand({
        device: 'mac-alpha',
        'tls-fingerprint': 'c'.repeat(64),
      }, {
        credentialStore: trackingStore,
        rotate: async () => {
          rotateCalls += 1;
          return { deviceId: 'mac-alpha', rotated: true };
        },
      }),
      /device command arguments are invalid/,
    );
    assert.strictEqual(heartbeatCalls, 0);
    assert.strictEqual(rotateCalls, 0);
    assert.strictEqual(keychainGets, 0);
    assert.strictEqual(keychainSets, 0);

    // Non-object args.
    await assert.rejects(
      runDeviceHeartbeatCommand(null, {
        credentialStore: trackingStore,
        heartbeat: async () => {
          heartbeatCalls += 1;
        },
      }),
      /device command arguments are invalid/,
    );
    assert.strictEqual(heartbeatCalls, 0);
  });

  it('rejects whitespace-only public CLI args before stdin/operation/Keychain', async () => {
    let stdinChunks = 0;
    let enrollCalls = 0;
    let heartbeatCalls = 0;
    let rotateCalls = 0;
    let keychainGets = 0;
    let keychainSets = 0;
    const trackingInput = {
      async *[Symbol.asyncIterator]() {
        stdinChunks += 1;
        yield 'must-not-be-read\n';
      },
    };
    const trackingStore = {
      async getToken() {
        keychainGets += 1;
        return 'token';
      },
      async setToken() {
        keychainSets += 1;
      },
    };

    // enroll: blank device
    await assert.rejects(
      runDeviceEnrollCommand({
        server: 'https://controller.invalid:3443',
        device: '   ',
        'tls-fingerprint': 'a'.repeat(64),
        'enrollment-code-stdin': true,
      }, {
        input: trackingInput,
        credentialStore: trackingStore,
        enroll: async () => {
          enrollCalls += 1;
        },
      }),
      /device command arguments are invalid/,
    );
    // heartbeat: blank server
    await assert.rejects(
      runDeviceHeartbeatCommand({
        server: '\t',
        device: 'mac-alpha',
        'tls-fingerprint': 'b'.repeat(64),
      }, {
        credentialStore: trackingStore,
        heartbeat: async () => {
          heartbeatCalls += 1;
        },
      }),
      /device command arguments are invalid/,
    );
    // rotate: blank tls-fingerprint
    await assert.rejects(
      runDeviceTokenRotateCommand({
        server: 'https://controller.invalid:3443',
        device: 'mac-alpha',
        'tls-fingerprint': ' \n ',
      }, {
        credentialStore: trackingStore,
        rotate: async () => {
          rotateCalls += 1;
        },
      }),
      /device command arguments are invalid/,
    );

    assert.strictEqual(stdinChunks, 0);
    assert.strictEqual(enrollCalls, 0);
    assert.strictEqual(heartbeatCalls, 0);
    assert.strictEqual(rotateCalls, 0);
    assert.strictEqual(keychainGets, 0);
    assert.strictEqual(keychainSets, 0);
  });
});
