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

// =============================================================================
// C7 G0c — requestPinnedDownload (streaming pinned chunk GET)
// Authority: design §§13.1–13.4, 8.6 + plan C7 RED Steps 1/10/10b
// Production export absent at RED → loadRequestPinnedDownload fails readably.
// requestPinnedBinary remains the bounded JSON helper; do not assume it becomes streaming.
// =============================================================================

const C7_TOKEN = 'c7-download-fixture-token-32chars!!';
const C7_DEVICE = 'device-c7-download';
const C7_ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const C7_SECRET_BODY = 'SECRET-BEARING-TLS-BODY-token=c7-secret-token-value-XYZ';
const C7_CHUNK_PATH = '/agent/restore/tasks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001/files/0/chunks/0';

/**
 * Dynamic load — avoid static top-level import of missing export killing all suites.
 * @returns {Promise<(opts: object) => Promise<{ bytesReceived: number, sha256: string }>>}
 */
async function loadRequestPinnedDownload() {
  const mod = await import('../src/device-client.js');
  assert.equal(
    typeof mod.requestPinnedDownload,
    'function',
    'C7 requestPinnedDownload must be exported from src/device-client.js',
  );
  assert.equal(
    typeof mod.requestPinnedBinary,
    'function',
    'C7 must retain requestPinnedBinary as bounded helper (not replace with streaming-only)',
  );
  return mod.requestPinnedDownload;
}

/**
 * Count case-insensitive header occurrences from Node rawHeaders.
 * @param {string[] | undefined} rawHeaders
 * @param {string} name
 */
function countRawHeader(rawHeaders, name) {
  const target = name.toLowerCase();
  let n = 0;
  if (!Array.isArray(rawHeaders)) return 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === target) n += 1;
  }
  return n;
}

/**
 * @param {Buffer} body
 * @param {Record<string, string | number>} [extra]
 */
function sendChunkOk(res, body, extra = {}) {
  const sha = createHash('sha256').update(body).digest('hex');
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-linke-chunk-sha256': sha,
    ...extra,
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendDownloadErrorJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function downloadErrorText(error) {
  if (!error || typeof error !== 'object') return String(error);
  const err = /** @type {Error & { code?: string, retryAfterSec?: number, statusCode?: unknown }} */ (error);
  const own = Object.keys(err)
    .filter((k) => k !== 'stack')
    .map((k) => String(/** @type {Record<string, unknown>} */ (err)[k]));
  return `${err}\n${err.message || ''}\n${err.code || ''}\n${err.statusCode ?? ''}\n${err.retryAfterSec ?? ''}\n${own.join('\n')}`;
}

describe('C7 G0c requestPinnedDownload', () => {
  it('C7 exports requestPinnedDownload; requestPinnedBinary export + 64KiB bound still present', async () => {
    const mod = await import('../src/device-client.js');
    assert.equal(typeof mod.requestPinnedBinary, 'function');
    assert.equal(mod.MAX_PINNED_JSON_RESPONSE_BYTES, 64 * 1024);
    assert.equal(typeof mod.requestPinnedDownload, 'function');
  });

  it('C7 pin failure: onChunk never called; secret body never accepted; fixed device-tls-fingerprint-mismatch', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    let onChunkCalls = 0;
    /** @type {Buffer[]} */
    const delivered = [];
    const server = await startHttpsFixture((req, res) => {
      void req;
      // Hostile: attempt to push secret-bearing body on mismatch path (client must not accept).
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': Buffer.byteLength(C7_SECRET_BODY),
        'x-linke-chunk-sha256': createHash('sha256').update(C7_SECRET_BODY).digest('hex'),
      });
      res.end(C7_SECRET_BODY);
    });
    try {
      await assert.rejects(
        requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: 'f'.repeat(64),
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: Buffer.byteLength(C7_SECRET_BODY),
          expectedSha256: createHash('sha256').update(C7_SECRET_BODY).digest('hex'),
          onChunk: (chunk) => {
            onChunkCalls += 1;
            delivered.push(Buffer.from(chunk));
          },
        }),
        (error) => {
          const text = downloadErrorText(error);
          // Registered code is device-tls-fingerprint-mismatch (contains the
          // substring "fingerprint"); leak checks exclude the code/message itself.
          const leakText = text
            .split(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH)
            .join('');
          return error.name === 'LinkeError'
            && error.code === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH
            && error.message === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH
            && onChunkCalls === 0
            && delivered.length === 0
            && !leakText.includes(C7_SECRET_BODY)
            && !leakText.includes(C7_TOKEN)
            && !leakText.includes('c7-secret-token')
            && !leakText.includes('f'.repeat(64))
            && !/certificate|SSL|TLS alert|self[- ]signed/i.test(leakText);
        },
      );
      assert.equal(onChunkCalls, 0);
    } finally {
      await server.close();
    }
  });

  it('C7 pin success: GET no body; path strict leading-slash; triad exact-one in rawHeaders; no file-path header', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    const payload = Buffer.from('c7-pin-success-bytes');
    /** @type {{ method?: string, url?: string, rawHeaders?: string[], headers?: object }} */
    let seen = {};
    let requestBodyBytes = 0;
    const server = await startHttpsFixture((req, res) => {
      seen = {
        method: req.method,
        url: req.url,
        rawHeaders: req.rawHeaders,
        headers: req.headers,
      };
      req.on('data', (c) => {
        requestBodyBytes += c.length;
      });
      req.on('end', () => {
        sendChunkOk(res, payload);
      });
    });
    try {
      const sha = createHash('sha256').update(payload).digest('hex');
      /** @type {Buffer[]} */
      const chunks = [];
      const result = await requestPinnedDownload({
        agentUrl: server.url,
        path: C7_CHUNK_PATH,
        tlsFingerprint: server.fingerprint,
        token: C7_TOKEN,
        deviceId: C7_DEVICE,
        protocolVersion: 2,
        expectedLength: payload.length,
        expectedSha256: sha,
        onChunk: (c) => {
          chunks.push(Buffer.from(c));
        },
      });
      assert.equal(seen.method, 'GET');
      assert.equal(seen.url, C7_CHUNK_PATH);
      assert.ok(String(seen.url).startsWith('/'));
      assert.equal(requestBodyBytes, 0);
      assert.equal(countRawHeader(seen.rawHeaders, 'authorization'), 1);
      assert.equal(countRawHeader(seen.rawHeaders, 'x-linke-device-id'), 1);
      assert.equal(countRawHeader(seen.rawHeaders, 'x-linke-protocol-version'), 1);
      assert.equal(seen.headers?.authorization, `Bearer ${C7_TOKEN}`);
      assert.equal(seen.headers?.['x-linke-device-id'], C7_DEVICE);
      assert.equal(seen.headers?.['x-linke-protocol-version'], '2');
      // File path must never enter URL/header (chunk uses fileIndex/chunkIndex only).
      const headerBlob = JSON.stringify(seen.headers || {});
      assert.ok(!headerBlob.includes('nested/'));
      assert.ok(!headerBlob.includes('apps/demo'));
      assert.ok(!/x-linke-file-path|x-file-path|x-restore-path/i.test(headerBlob));
      assert.equal(result.bytesReceived, payload.length);
      assert.equal(result.sha256, sha);
      assert.deepEqual(Buffer.concat(chunks), payload);
    } finally {
      await server.close();
    }
  });

  it('C7 Content-Length + X-Linke-Chunk-Sha256 must exact-match expectedLength/expectedSha256 and actual body', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    const payload = Buffer.from('exact-match-chunk-body-c7');
    const trueSha = createHash('sha256').update(payload).digest('hex');

    // Happy exact match
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendChunkOk(res, payload);
      });
      try {
        const result = await requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: server.fingerprint,
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: payload.length,
          expectedSha256: trueSha,
          onChunk: () => {},
        });
        assert.equal(result.bytesReceived, payload.length);
        assert.equal(result.sha256, trueSha);
      } finally {
        await server.close();
      }
    }

    // Header Content-Length ≠ expectedLength
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': payload.length + 1,
          'x-linke-chunk-sha256': trueSha,
        });
        res.end(payload);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            expectedSha256: trueSha,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.retryable === false
            && e.statusCode === 422,
        );
      } finally {
        await server.close();
      }
    }

    // Header digest ≠ expectedSha256
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': payload.length,
          'x-linke-chunk-sha256': 'a'.repeat(64),
        });
        res.end(payload);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            expectedSha256: trueSha,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        );
      } finally {
        await server.close();
      }
    }
  });

  it('C7 under-read / over-read / early EOF / corrupt digest → restore-integrity-failed; no late onChunk', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    const payload = Buffer.from('0123456789abcdef'); // 16 bytes
    const trueSha = createHash('sha256').update(payload).digest('hex');
    const short8 = payload.subarray(0, 8);
    const sha8 = createHash('sha256').update(short8).digest('hex');

    // under-read: Content-Length claims 16, body ends at 8
    {
      let onChunkCalls = 0;
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': 16,
          'x-linke-chunk-sha256': trueSha,
        });
        res.write(payload.subarray(0, 8));
        res.end();
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 16,
            expectedSha256: trueSha,
            onChunk: () => {
              onChunkCalls += 1;
            },
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.retryable === false
            && e.statusCode === 422,
        );
        const after = onChunkCalls;
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(onChunkCalls, after, 'no late onChunk after integrity settle');
      } finally {
        await server.close();
      }
    }

    // over-read oracle (P1-4):
    // Node HTTP framing contract (client-side):
    //   1) Server advertises Content-Length: 8 and X-Linke-Chunk-Sha256=sha8, expectedLength=8.
    //   2) Server then writes 16 body bytes on the raw TLS socket (past CL).
    //   3) Node HTTP parser surfaces HPE_CLOSED_CONNECTION / incomplete message on the
    //      response stream (event order: headers → partial data → parser error / close).
    // Implementation MUST map this to RESTORE_INTEGRITY_FAILED (retryable=false, 422).
    // MUST NOT resolve as a truncated success {bytesReceived:8, sha256:sha8}.
    // MUST NOT map to RESTORE_INTERRUPTED. Do not assert raw error text externally.
    {
      let onChunkCalls = 0;
      let settled = false;
      /** @type {{ bytesReceived: number, sha256: string } | null} */
      let resolved = null;
      const server = await startHttpsFixture((req, res) => {
        void res;
        // Raw TLS/HTTP response — bypass ServerResponse CL enforcement so client
        // truly observes CL=8 with 16 body bytes (HPE_CLOSED_CONNECTION path).
        const head = [
          'HTTP/1.1 200 OK',
          'Content-Type: application/octet-stream',
          'Content-Length: 8',
          `X-Linke-Chunk-Sha256: ${sha8}`,
          'Cache-Control: no-store',
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        req.socket.write(head);
        req.socket.write(payload); // 16 bytes after CL=8
        req.socket.end();
      });
      try {
        await assert.rejects(
          (async () => {
            resolved = await requestPinnedDownload({
              agentUrl: server.url,
              path: C7_CHUNK_PATH,
              tlsFingerprint: server.fingerprint,
              token: C7_TOKEN,
              deviceId: C7_DEVICE,
              protocolVersion: 2,
              expectedLength: 8,
              expectedSha256: sha8,
              onChunk: () => {
                if (settled) assert.fail('late onChunk after integrity failure');
                onChunkCalls += 1;
              },
            });
            return resolved;
          })(),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.retryable === false
            && e.statusCode === 422
            && e.code !== ERROR_CODES.RESTORE_INTERRUPTED,
        );
        settled = true;
        // Explicit anti-oracle: never a silent truncated success of the CL=8 prefix.
        assert.equal(resolved, null, 'over-read must not resolve successfully');
        assert.notDeepEqual(
          resolved,
          { bytesReceived: 8, sha256: sha8 },
          'over-read must never settle as {bytesReceived:8,sha256:sha8}',
        );
        await new Promise((r) => setTimeout(r, 20));
        void onChunkCalls;
      } finally {
        await server.close();
      }
    }

    // early EOF / cut socket mid-body with known expectedLength not fully received (P2-6):
    // destroy/cut after partial write → ONLY RESTORE_INTEGRITY_FAILED, retryable=false, 422.
    // RESTORE_INTERRUPTED is NOT an allowed mapping when expectedLength is known and short.
    {
      let onChunkAfterFail = 0;
      let failed = false;
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': 16,
          'x-linke-chunk-sha256': trueSha,
        });
        // Flush headers+partial body to the client before destroying; an immediate
        // destroy races the TLS flush and looks like "no response" (interrupt).
        res.write(payload.subarray(0, 4), () => {
          res.socket?.destroy();
        });
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 16,
            expectedSha256: trueSha,
            onChunk: () => {
              if (failed) onChunkAfterFail += 1;
            },
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.retryable === false
            && e.statusCode === 422
            && e.code !== ERROR_CODES.RESTORE_INTERRUPTED,
        );
        failed = true;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(onChunkAfterFail, 0);
      } finally {
        await server.close();
      }
    }

    // corrupt body digest vs header/expected
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        const wrong = Buffer.from('WRONG-DIGEST-BODY!!');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': wrong.length,
          'x-linke-chunk-sha256': trueSha, // lies
        });
        res.end(wrong);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: Buffer.byteLength('WRONG-DIGEST-BODY!!'),
            expectedSha256: trueSha,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.retryable === false
            && e.statusCode === 422,
        );
      } finally {
        await server.close();
      }
    }
  });

  it('C7 idleTimeout reset only on nonempty data; total timeout independent; single-settle late events', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    const partA = Buffer.from('AAAA');
    const partB = Buffer.from('BBBB');
    const full = Buffer.concat([partA, partB]);
    const sha = createHash('sha256').update(full).digest('hex');

    // nonempty data resets idle: two spaced writes within idle window complete
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': full.length,
          'x-linke-chunk-sha256': sha,
        });
        res.write(partA);
        setTimeout(() => {
          res.write(partB);
          res.end();
        }, 40);
      });
      try {
        const result = await requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: server.fingerprint,
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: full.length,
          expectedSha256: sha,
          timeoutMs: 5_000,
          idleTimeoutMs: 80,
          onChunk: () => {},
        });
        assert.equal(result.bytesReceived, full.length);
        assert.equal(result.sha256, sha);
      } finally {
        await server.close();
      }
    }

    // idle timeout fires when no data arrives
    {
      let onChunkCalls = 0;
      let settleCount = 0;
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': 8,
          'x-linke-chunk-sha256': createHash('sha256').update(Buffer.alloc(8)).digest('hex'),
        });
        // Flush headers so the client starts idle before any body bytes.
        // Without flush, Node may coalesce headers with the late write.
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        // Never write body until after idle should have fired.
        setTimeout(() => {
          // Late data after client should have settled.
          try {
            res.write(Buffer.alloc(8));
            res.end();
          } catch {
            // ignore
          }
        }, 200);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 8,
            expectedSha256: createHash('sha256').update(Buffer.alloc(8)).digest('hex'),
            timeoutMs: 5_000,
            idleTimeoutMs: 40,
            onChunk: () => {
              onChunkCalls += 1;
            },
          }).then(
            (v) => {
              settleCount += 1;
              return v;
            },
            (e) => {
              settleCount += 1;
              throw e;
            },
          ),
          (e) => e.code === ERROR_CODES.RESTORE_INTERRUPTED
            && e.retryable === true
            && e.statusCode === null,
        );
        await new Promise((r) => setTimeout(r, 250));
        assert.equal(settleCount, 1, 'single-settle');
        assert.equal(onChunkCalls, 0, 'no onChunk after idle timeout / late write');
      } finally {
        await server.close();
      }
    }

    // total timeout not extended by data: keep sending within idle but past total
    {
      let onChunkCalls = 0;
      let settleCount = 0;
      const server = await startHttpsFixture((req, res) => {
        void req;
        const big = Buffer.alloc(4, 0x61);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': 1000,
          'x-linke-chunk-sha256': 'b'.repeat(64),
        });
        let n = 0;
        const tick = () => {
          if (n >= 30) return;
          n += 1;
          try {
            res.write(big);
          } catch {
            return;
          }
          setTimeout(tick, 25);
        };
        tick();
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 1000,
            expectedSha256: 'b'.repeat(64),
            timeoutMs: 90,
            idleTimeoutMs: 200,
            onChunk: () => {
              onChunkCalls += 1;
            },
          }).then(
            (v) => {
              settleCount += 1;
              return v;
            },
            (e) => {
              settleCount += 1;
              throw e;
            },
          ),
          (e) => e.code === ERROR_CODES.RESTORE_INTERRUPTED && e.retryable === true,
        );
        const after = onChunkCalls;
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(settleCount, 1);
        assert.equal(onChunkCalls, after, 'no late onChunk after total timeout settle');
      } finally {
        await server.close();
      }
    }
  });

  it('C7 onChunk async backpressure: next chunk waits; throw/reject fail-closes without further callbacks', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    const p1 = Buffer.from('part-one-xxxxx');
    const p2 = Buffer.from('part-two-yyyyy');
    const full = Buffer.concat([p1, p2]);
    const sha = createHash('sha256').update(full).digest('hex');

    // backpressure: second delivery must wait for first promise
    {
      /** @type {string[]} */
      const order = [];
      let releaseFirst;
      const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': full.length,
          'x-linke-chunk-sha256': sha,
        });
        res.write(p1);
        setImmediate(() => {
          res.write(p2);
          res.end();
        });
      });
      try {
        const pending = requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: server.fingerprint,
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: full.length,
          expectedSha256: sha,
          onChunk: async (chunk) => {
            order.push(`enter:${chunk.length}`);
            if (order.filter((x) => x.startsWith('enter:')).length === 1) {
              await firstGate;
            }
            order.push(`leave:${chunk.length}`);
          },
        });
        // Allow first enter, ensure second has not entered yet.
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(
          order.filter((x) => x.startsWith('enter:')),
          [`enter:${p1.length}`],
          'second onChunk must wait for first promise',
        );
        releaseFirst();
        const result = await pending;
        assert.equal(result.bytesReceived, full.length);
        assert.ok(order.includes(`enter:${p2.length}`));
        // p1/p2 may share equal byte length — use enter indices, not indexOf(length).
        const enterIdx = [];
        const leaveIdx = [];
        for (let i = 0; i < order.length; i += 1) {
          if (order[i].startsWith('enter:')) enterIdx.push(i);
          if (order[i].startsWith('leave:')) leaveIdx.push(i);
        }
        assert.equal(enterIdx.length, 2);
        assert.equal(leaveIdx.length, 2);
        assert.ok(leaveIdx[0] < enterIdx[1], 'first leave must precede second enter');
      } finally {
        await server.close();
      }
    }

    // onChunk throw fail-close
    {
      let calls = 0;
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendChunkOk(res, full);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: full.length,
            expectedSha256: sha,
            onChunk: () => {
              calls += 1;
              throw new Error('onChunk-boom-must-not-leak-path-/Users/secret');
            },
          }),
          (e) => {
            const text = downloadErrorText(e);
            return (e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
              || e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
              || e.code === ERROR_CODES.RESTORE_INTERRUPTED)
              && !text.includes('/Users/secret')
              && !text.includes('onChunk-boom');
          },
        );
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(calls, 1, 'no further onChunk after throw');
      } finally {
        await server.close();
      }
    }

    // onChunk reject fail-close
    {
      let calls = 0;
      const server = await startHttpsFixture((req, res) => {
        void req;
        // split into two writes so second would be attempted without fail-close
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': full.length,
          'x-linke-chunk-sha256': sha,
        });
        res.write(p1);
        setImmediate(() => {
          res.write(p2);
          res.end();
        });
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: full.length,
            expectedSha256: sha,
            onChunk: async () => {
              calls += 1;
              if (calls === 1) {
                await Promise.reject(new Error('reject-secret-token=abc'));
              }
            },
          }),
          (e) => {
            const text = downloadErrorText(e);
            return !text.includes('reject-secret-token') && !text.includes('abc');
          },
        );
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(calls, 1, 'no further onChunk after reject');
      } finally {
        await server.close();
      }
    }
  });

  it('C7 parameter fail-closed before socket (length/sha/timeouts/signal/protocol/device/token/path)', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();
    let accepted = 0;
    const server = await startHttpsFixture((req, res) => {
      accepted += 1;
      void req;
      sendChunkOk(res, Buffer.from('x'));
    });
    const base = {
      agentUrl: server.url,
      path: C7_CHUNK_PATH,
      tlsFingerprint: server.fingerprint,
      token: C7_TOKEN,
      deviceId: C7_DEVICE,
      protocolVersion: 2,
      expectedLength: 1,
      expectedSha256: createHash('sha256').update(Buffer.from('x')).digest('hex'),
      onChunk: () => {},
    };
    try {
      const illegal = [
        { expectedLength: -1 },
        { expectedLength: 1.5 },
        { expectedLength: Number.MAX_SAFE_INTEGER + 1 },
        { expectedLength: '8' },
        { expectedSha256: 'ABCDEF' + 'a'.repeat(58) }, // upper not allowed
        { expectedSha256: 'a'.repeat(63) },
        { expectedSha256: 'g'.repeat(64) },
        { timeoutMs: 0 },
        { timeoutMs: -5 },
        { timeoutMs: 300_001 },
        { idleTimeoutMs: 0 },
        { idleTimeoutMs: -1 },
        { idleTimeoutMs: 300_001 },
        { signal: { aborted: 'nope' } },
        { signal: {} },
        { protocolVersion: 1.5 },
        { protocolVersion: '2' },
        { deviceId: '' },
        { token: '' },
        { path: 'agent/no-leading-slash' },
        { path: '' },
        { path: 'relative/path' },
        { onChunk: null },
        { onChunk: undefined },
      ];
      for (const patch of illegal) {
        const before = accepted;
        await assert.rejects(
          async () => requestPinnedDownload({ ...base, ...patch }),
          (e) => e instanceof Error
            && (e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
              || e.code === ERROR_CODES.DEVICE_TOKEN_INVALID
              || e.code === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH
              || e.code === ERROR_CODES.RESTORE_TASK_INVALID
              || e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED),
          `illegal ${JSON.stringify(patch)}`,
        );
        assert.equal(accepted, before, `must fail before socket for ${JSON.stringify(patch)}`);
      }
      // already-aborted signal fails closed before request
      {
        const ac = new AbortController();
        ac.abort();
        const before = accepted;
        // Wrap: sync fail-closed throw must surface as rejection to assert.rejects.
        await assert.rejects(
          async () => requestPinnedDownload({ ...base, signal: ac.signal }),
          (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        );
        assert.equal(accepted, before);
      }

      // expectedSha256 null / bad format still fail-close before socket (optional field)
      {
        for (const bad of [null, '', 'ABCDEF' + 'a'.repeat(58), 'a'.repeat(63), 123]) {
          const before = accepted;
          await assert.rejects(
            async () => requestPinnedDownload({ ...base, expectedSha256: bad }),
            (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
              && e.retryable === false,
            `bad expectedSha256 ${String(bad)}`,
          );
          assert.equal(accepted, before, `must fail before socket for expectedSha256=${String(bad)}`);
        }
      }
    } finally {
      await server.close();
    }
  });

  it('C7 expectedSha256 optional: omit succeeds with exact-one header===body; bad/missing/dup header or body mismatch → integrity', async () => {
    // C7 contract clarification: GET task files[] has no per-chunk digest.
    // Multi-chunk may omit expectedSha256; still exact-one X-Linke-Chunk-Sha256 + body match.
    const requestPinnedDownload = await loadRequestPinnedDownload();
    const payload = Buffer.from('optional-expected-sha-body-c7');
    const trueSha = createHash('sha256').update(payload).digest('hex');

    // omit expectedSha256: header/body agree → success; returned sha256 is verified digest
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendChunkOk(res, payload);
      });
      try {
        /** @type {Buffer[]} */
        const got = [];
        const result = await requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: server.fingerprint,
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: payload.length,
          // expectedSha256 intentionally omitted
          onChunk: (c) => {
            got.push(Buffer.from(c));
          },
        });
        assert.equal(result.bytesReceived, payload.length);
        assert.equal(result.sha256, trueSha);
        assert.deepEqual(Buffer.concat(got), payload);
      } finally {
        await server.close();
      }
    }

    // provided expectedSha256 still required-when-provided: header/body/expected 全等
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendChunkOk(res, payload);
      });
      try {
        const result = await requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: server.fingerprint,
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: payload.length,
          expectedSha256: trueSha,
          onChunk: () => {},
        });
        assert.equal(result.sha256, trueSha);
      } finally {
        await server.close();
      }
    }

    // missing chunk-sha header → integrity (omit expected)
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': payload.length,
        });
        res.end(payload);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.retryable === false
            && e.statusCode === 422,
        );
      } finally {
        await server.close();
      }
    }

    // duplicate X-Linke-Chunk-Sha256 → integrity
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        // rawHeaders-style duplicate via setHeader twice is hard; write raw response
        const head = [
          'HTTP/1.1 200 OK',
          'Content-Type: application/octet-stream',
          `Content-Length: ${payload.length}`,
          `X-Linke-Chunk-Sha256: ${trueSha}`,
          `X-Linke-Chunk-Sha256: ${trueSha}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        req.socket.write(head);
        req.socket.write(payload);
        req.socket.end();
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        );
      } finally {
        await server.close();
      }
    }

    // bad format header (upper hex) → integrity
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': payload.length,
          'x-linke-chunk-sha256': trueSha.toUpperCase(),
        });
        res.end(payload);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        );
      } finally {
        await server.close();
      }
    }

    // body hash ≠ header digest (omit expected) → integrity
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': payload.length,
          'x-linke-chunk-sha256': 'a'.repeat(64),
        });
        res.end(payload);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        );
      } finally {
        await server.close();
      }
    }

    // provided expectedSha256 but header differs → integrity (required-when-provided retained)
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendChunkOk(res, payload);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: payload.length,
            expectedSha256: 'b'.repeat(64),
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED,
        );
      } finally {
        await server.close();
      }
    }
  });

  it('C7 error mapping: interrupt/timeout; 429 dual codes + Retry-After; bounded error JSON no leak', async () => {
    const requestPinnedDownload = await loadRequestPinnedDownload();

    // disconnect → restore-interrupted
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        void res;
        req.socket?.destroy();
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 4,
            expectedSha256: createHash('sha256').update(Buffer.from('abcd')).digest('hex'),
            onChunk: () => {},
            timeoutMs: 2_000,
          }),
          (e) => e.code === ERROR_CODES.RESTORE_INTERRUPTED
            && e.retryable === true
            && e.statusCode === null
            && !downloadErrorText(e).includes(C7_TOKEN),
        );
      } finally {
        await server.close();
      }
    }

    // 429 device-rate-limited with Retry-After clamp 1..30
    {
      let n = 0;
      const server = await startHttpsFixture((req, res) => {
        void req;
        n += 1;
        if (n === 1) {
          return sendDownloadErrorJson(
            res,
            429,
            { error: ERROR_CODES.DEVICE_RATE_LIMITED },
            { 'retry-after': '99' },
          );
        }
        return sendDownloadErrorJson(
          res,
          429,
          { error: ERROR_CODES.RESTORE_BACKPRESSURE },
          { 'retry-after': '0' },
        );
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 1,
            expectedSha256: C7_ZERO_SHA,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.DEVICE_RATE_LIMITED
            && e.statusCode === 429
            && e.retryable === true
            && e.retryAfterSec === 30,
        );
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 1,
            expectedSha256: C7_ZERO_SHA,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.RESTORE_BACKPRESSURE
            && e.statusCode === 429
            && e.retryable === true
            && e.retryAfterSec === 1,
        );
      } finally {
        await server.close();
      }
    }

    // 429 wrong code → non-retry, no retryAfterSec
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendDownloadErrorJson(
          res,
          429,
          { error: ERROR_CODES.RESTORE_TASK_CONFLICT },
          { 'retry-after': '5' },
        );
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 1,
            expectedSha256: C7_ZERO_SHA,
            onChunk: () => {},
          }),
          (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.retryAfterSec === undefined
            && e.code !== ERROR_CODES.RESTORE_BACKPRESSURE,
        );
      } finally {
        await server.close();
      }
    }

    // error JSON with secrets stays bounded and non-leaking; onChunk 0
    {
      let onChunkCalls = 0;
      const leak = {
        error: ERROR_CODES.RESTORE_TASK_INVALID,
        token: C7_TOKEN,
        path: '/Users/private/secret-restore-target',
        stack: 'Error: raw\n    at /Users/private/x.js:1:1',
        body: 'a'.repeat(200_000),
      };
      const server = await startHttpsFixture((req, res) => {
        void req;
        sendDownloadErrorJson(res, 400, leak);
      });
      try {
        await assert.rejects(
          requestPinnedDownload({
            agentUrl: server.url,
            path: C7_CHUNK_PATH,
            tlsFingerprint: server.fingerprint,
            token: C7_TOKEN,
            deviceId: C7_DEVICE,
            protocolVersion: 2,
            expectedLength: 1,
            expectedSha256: C7_ZERO_SHA,
            onChunk: () => {
              onChunkCalls += 1;
            },
          }),
          (e) => {
            const text = downloadErrorText(e);
            return e instanceof Error
              && onChunkCalls === 0
              && !text.includes(C7_TOKEN)
              && !text.includes('/Users/private')
              && !text.includes('raw\n')
              && !text.includes('a'.repeat(1000));
          },
        );
      } finally {
        await server.close();
      }
    }

    // AbortSignal single-settle without raw AbortError leak
    {
      const server = await startHttpsFixture((req, res) => {
        void req;
        void res;
      });
      const ac = new AbortController();
      try {
        const pending = requestPinnedDownload({
          agentUrl: server.url,
          path: C7_CHUNK_PATH,
          tlsFingerprint: server.fingerprint,
          token: C7_TOKEN,
          deviceId: C7_DEVICE,
          protocolVersion: 2,
          expectedLength: 4,
          expectedSha256: createHash('sha256').update(Buffer.from('abcd')).digest('hex'),
          onChunk: () => {},
          signal: ac.signal,
          timeoutMs: 30_000,
        });
        ac.abort();
        await assert.rejects(
          pending,
          (e) => {
            const text = downloadErrorText(e);
            return e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
              && !text.includes('AbortError')
              && !text.includes('This operation was aborted');
          },
        );
      } finally {
        await server.close();
      }
    }
  });

  it('C7 requestPinnedBinary regression pin: still works for JSON GET and does not require onChunk', async () => {
    // Ensures streaming API addition does not break bounded helper shape used as requestJson.
    const server = await startHttpsFixture((req, res) => {
      void req;
      sendJson(res, 200, { ok: true, via: 'binary-json' });
    });
    try {
      const response = await requestPinnedBinary({
        agentUrl: server.url,
        path: '/agent/restore/tasks/claim',
        tlsFingerprint: server.fingerprint,
        method: 'POST',
        token: C7_TOKEN,
        deviceId: C7_DEVICE,
        body: {},
        bodyMode: 'json',
        timeoutMs: 5_000,
      });
      assert.deepEqual(response, { ok: true, via: 'binary-json' });
    } finally {
      await server.close();
    }
  });
});
