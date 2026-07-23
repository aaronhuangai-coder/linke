import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceRegistry } from '../src/device-registry.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import {
  createAgentListener,
  MAX_AGENT_JSON_BODY_BYTES,
} from '../src/agent-listener.js';

/**
 * Build a loopback test identity with real OpenSSL cert (never touches Keychain).
 * @returns {Promise<{ keyPem: string, certPem: string }>}
 */
async function buildTestIdentity() {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  return { keyPem, certPem };
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * @param {{
 *   identity?: { keyPem: string, certPem: string },
 *   registry?: DeviceRegistry,
 *   onHeartbeat?: Function,
 *   rateLimit?: { check: Function },
 *   uploadRateLimit?: { check: Function },
 *   uploadService?: object,
 *   restoreRateLimit?: { check: Function },
 *   restoreService?: object,
 *   timers?: { now?: Function, setTimeout?: Function, clearTimeout?: Function },
 * }} [options]
 */
async function startAgentFixture(options = {}) {
  const dataDir = options.registry
    ? null
    : await mkdtemp(join(tmpdir(), 'linke-agent-listener-'));
  const registry = options.registry || new DeviceRegistry({ dataDir });
  const identity = options.identity || await buildTestIdentity();
  const heartbeats = [];
  const onHeartbeat = options.onHeartbeat || (async (event) => {
    heartbeats.push(event);
  });
  const server = createAgentListener({
    identity,
    registry,
    onHeartbeat,
    rateLimit: options.rateLimit,
    uploadRateLimit: options.uploadRateLimit,
    uploadService: options.uploadService,
    restoreRateLimit: options.restoreRateLimit,
    restoreService: options.restoreService,
    ...(options.timers ? { timers: options.timers } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  /**
   * @param {string} method
   * @param {string} path
   * @param {{
   *   body?: string | Buffer,
   *   token?: string,
   *   headers?: Record<string, string>,
   *   chunked?: boolean,
   * }} [opts]
   */
  function requestAgent(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const headers = { ...(opts.headers || {}) };
      if (opts.token !== undefined) {
        headers.authorization = `Bearer ${opts.token}`;
      }
      let body = opts.body;
      if (body !== undefined && !opts.chunked && headers['content-length'] === undefined) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        headers['content-length'] = String(buf.length);
        body = buf;
      }
      if (body !== undefined && headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json';
      }
      const req = https.request({
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
        rejectUnauthorized: false,
        agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw);
          } catch {
            parsed = { __unparsed: raw };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw,
          });
        });
      });
      req.on('error', reject);
      if (opts.chunked && body !== undefined) {
        req.write(body);
        req.end();
      } else if (body !== undefined) {
        req.end(body);
      } else {
        req.end();
      }
    });
  }

  function postAgent(path, payload, token) {
    return requestAgent('POST', path, {
      body: JSON.stringify(payload),
      token,
    });
  }

  function postAgentRaw(path, rawBody, extra = {}) {
    return requestAgent('POST', path, {
      body: rawBody,
      ...extra,
    });
  }

  return {
    server,
    port,
    registry,
    identity,
    heartbeats,
    dataDir,
    requestAgent,
    postAgent,
    postAgentRaw,
    async post(path, payload, token) {
      return postAgent(path, payload, token);
    },
    async cleanup() {
      await closeServer(server);
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * @param {DeviceRegistry} registry
 * @param {string} deviceId
 * @param {number} [protocolVersion=2]
 */
async function enrollFixture(registry, deviceId, protocolVersion = 2) {
  const issued = await registry.issueEnrollment({ deviceId });
  return {
    code: issued.code,
    protocolVersion,
    enrollBody: {
      deviceId,
      protocolVersion,
      enrollmentCode: issued.code,
    },
  };
}

/**
 * Enroll via HTTPS and return device token (never logged).
 * @param {Awaited<ReturnType<typeof startAgentFixture>>} fixture
 * @param {string} deviceId
 * @param {number} [protocolVersion=2]
 */
async function enrollViaHttps(fixture, deviceId, protocolVersion = 2) {
  const prep = await enrollFixture(fixture.registry, deviceId, protocolVersion);
  const enrolled = await fixture.postAgent('/agent/enroll', prep.enrollBody);
  assert.equal(enrolled.status, 201);
  assert.match(enrolled.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  return {
    token: enrolled.body.deviceToken,
    deviceId,
    protocolVersion,
  };
}

/** Assert public error shape is exactly { error: <registered kebab code> }. */
function assertPublicError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, { error: code });
  assert.equal(Object.keys(response.body).length, 1);
}

/** Assert response text never contains known secret material. */
function assertNoSecretEcho(serialized, secrets = []) {
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      assert.ok(!serialized.includes(secret));
    }
  }
  assert.doesNotMatch(serialized, /Keychain|openssl|PRIVATE KEY|BEGIN EC|\/Users\//i);
}

/**
 * Raw TLS HTTP/1.1 client for adversarial probes (duplicate headers, slow chunked bodies).
 * Does not print response secrets; callers must avoid logging tokens.
 * @param {{
 *   port: number,
 *   head: string,
 *   bodyParts?: Array<string|Buffer>,
 *   endAfterBody?: boolean,
 *   timeoutMs?: number,
 * }} options
 */
function rawTlsHttpExchange({
  port,
  head,
  bodyParts = [],
  endAfterBody = false,
  timeoutMs = 400,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      finish({ kind: 'timeout', raw: buf.toString('utf8') });
    }, timeoutMs);

    socket.on('secureConnect', () => {
      socket.write(head);
      for (const part of bodyParts) {
        socket.write(part);
      }
      if (endAfterBody) socket.end();
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      const sep = text.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const headerText = text.slice(0, sep);
      const bodyText = text.slice(sep + 4);
      const statusMatch = /^HTTP\/1\.\d (\d+)/.exec(headerText);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const clMatch = /content-length:\s*(\d+)/i.exec(headerText);
      if (!clMatch) return;
      const need = Number(clMatch[1]);
      const bodyBuf = Buffer.from(bodyText, 'utf8');
      if (bodyBuf.length < need) return;
      const rawBody = bodyBuf.subarray(0, need).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = { __unparsed: rawBody };
      }
      finish({ kind: 'response', status, body: parsed, raw: rawBody });
    });

    socket.on('error', (error) => {
      finish({ kind: 'error', code: error && error.code });
    });
  });
}

/**
 * Instrument registry + heartbeat counters for fail-closed assertions.
 * @param {DeviceRegistry} registry
 */
function instrumentRegistry(registry) {
  const counts = {
    consumeEnrollment: 0,
    authenticate: 0,
    beginTokenRotation: 0,
    confirmTokenRotation: 0,
    onHeartbeat: 0,
  };
  for (const method of [
    'consumeEnrollment',
    'authenticate',
    'beginTokenRotation',
    'confirmTokenRotation',
  ]) {
    const original = registry[method].bind(registry);
    registry[method] = async (...args) => {
      counts[method] += 1;
      return original(...args);
    };
  }
  return counts;
}

describe('Agent HTTPS listener', () => {
  /** @type {Awaited<ReturnType<typeof startAgentFixture>>} */
  let fixture;

  before(async () => {
    fixture = await startAgentFixture();
  });

  after(async () => {
    if (fixture) await fixture.cleanup();
  });

  it('exports a 64 KiB body limit constant', () => {
    assert.equal(MAX_AGENT_JSON_BODY_BYTES, 64 * 1024);
  });

  it('freezes server headersTimeout=10000 and requestTimeout=0 (C6 dual-timer architecture)', () => {
    // Design §6.4.1: close server-level hard ceiling; per-route reader enforces G0a 15s.
    assert.equal(fixture.server.headersTimeout, 10_000);
    assert.equal(fixture.server.requestTimeout, 0);
  });

  it('enrolls once, authenticates heartbeat and rotates the token', async () => {
    const issued = await fixture.registry.issueEnrollment({ deviceId: 'mac-alpha' });
    const enrolled = await fixture.postAgent('/agent/enroll', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
      enrollmentCode: issued.code,
    });
    assert.equal(enrolled.status, 201);
    assert.match(enrolled.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(enrolled.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(enrolled.headers['cache-control'], 'no-store');
    assert.equal(
      Number(enrolled.headers['content-length']),
      Buffer.byteLength(enrolled.raw),
    );

    const heartbeat = await fixture.postAgent('/agent/heartbeat', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
      hostname: 'alpha.local',
    }, enrolled.body.deviceToken);
    assert.equal(heartbeat.status, 200);
    assert.deepEqual(heartbeat.body, { deviceId: 'mac-alpha', accepted: true });

    const rotated = await fixture.postAgent('/agent/token/rotate', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
    }, enrolled.body.deviceToken);
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);

    // old token still valid before confirm
    const oldBeforeConfirm = await fixture.postAgent('/agent/heartbeat', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
    }, enrolled.body.deviceToken);
    assert.equal(oldBeforeConfirm.status, 200);

    // pending token cannot heartbeat
    const pendingHeartbeat = await fixture.postAgent('/agent/heartbeat', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
    }, rotated.body.deviceToken);
    assertPublicError(pendingHeartbeat, 401, 'device-token-invalid');

    const confirmed = await fixture.postAgent('/agent/token/rotate/confirm', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
    }, rotated.body.deviceToken);
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.body, { deviceId: 'mac-alpha', rotated: true });

    const oldToken = await fixture.postAgent('/agent/heartbeat', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
    }, enrolled.body.deviceToken);
    assertPublicError(oldToken, 401, 'device-token-invalid');

    // new token works after confirm
    const after = await fixture.postAgent('/agent/heartbeat', {
      deviceId: 'mac-alpha',
      protocolVersion: 2,
    }, rotated.body.deviceToken);
    assert.equal(after.status, 200);

    assertNoSecretEcho(JSON.stringify(enrolled.body) + JSON.stringify(rotated.body), [
      issued.code,
      fixture.identity.keyPem,
    ]);
  });

  it('rejects scope mismatch, unknown token, revoked and protocol window edges', async () => {
    const local = await startAgentFixture();
    try {
      const { token } = await enrollViaHttps(local, 'mac-scope');

      const wrongScope = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-beta',
        protocolVersion: 2,
      }, token);
      assertPublicError(wrongScope, 403, 'device-scope-mismatch');

      const unknownToken = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-scope',
        protocolVersion: 2,
      }, 'x'.repeat(43));
      assertPublicError(unknownToken, 401, 'device-token-invalid');

      const futureProtocol = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-scope',
        protocolVersion: 3,
      }, token);
      assertPublicError(futureProtocol, 426, 'device-protocol-unsupported');

      const olderProtocol = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-scope',
        protocolVersion: 0,
      }, token);
      assertPublicError(olderProtocol, 426, 'device-protocol-unsupported');

      // N-1 enrollment + heartbeat accepted
      const n1 = await enrollViaHttps(local, 'mac-n-minus-one', 1);
      const accepted = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-n-minus-one',
        protocolVersion: 1,
      }, n1.token);
      assert.equal(accepted.status, 200);

      await local.registry.revokeDevice('mac-scope');
      const revoked = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-scope',
        protocolVersion: 2,
      }, token);
      assertPublicError(revoked, 403, 'device-revoked');

      // suspend via fingerprint accept → token invalid (not revoked)
      const { token: activeToken } = await enrollViaHttps(local, 'mac-suspend');
      await local.registry.acceptControllerFingerprint('a'.repeat(64));
      const suspended = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-suspend',
        protocolVersion: 2,
      }, activeToken);
      assertPublicError(suspended, 403, 'device-token-invalid');
    } finally {
      await local.cleanup();
    }
  });

  it('has no Web/admin/static/unknown agent routes and no registry side effects', async () => {
    const local = await startAgentFixture();
    try {
      let consumeCalls = 0;
      const originalConsume = local.registry.consumeEnrollment.bind(local.registry);
      local.registry.consumeEnrollment = async (...args) => {
        consumeCalls += 1;
        return originalConsume(...args);
      };
      let authCalls = 0;
      const originalAuth = local.registry.authenticate.bind(local.registry);
      local.registry.authenticate = async (...args) => {
        authCalls += 1;
        return originalAuth(...args);
      };

      const paths = [
        ['GET', '/'],
        ['GET', '/api/health'],
        ['POST', '/api/backup'],
        ['POST', '/api/restore'],
        ['GET', '/admin'],
        ['GET', '/index.html'],
        ['POST', '/agent/upload'],
        ['POST', '/agent/restore'],
        ['GET', '/agent/enroll'],
        ['PUT', '/agent/enroll'],
        ['POST', '/agent/enroll?x=1'],
        ['POST', '/agent/heartbeat?x=1'],
        ['POST', '/agent/token/rotate/extra'],
        ['OPTIONS', '/agent/enroll'],
      ];
      for (const [method, path] of paths) {
        const response = await local.requestAgent(method, path, {
          body: method === 'POST' || method === 'PUT'
            ? JSON.stringify({ deviceId: 'mac-x', protocolVersion: 2 })
            : undefined,
        });
        assertPublicError(response, 404, 'device-route-not-found');
      }
      assert.equal(consumeCalls, 0);
      assert.equal(authCalls, 0);
    } finally {
      await local.cleanup();
    }
  });

  it('bounds body size, rejects invalid JSON and never resets the socket', async () => {
    const local = await startAgentFixture();
    try {
      // exact 64 KiB valid JSON object is accepted (invalid enroll code → enrollment error, not body error)
      const exactPayload = (() => {
        const prefix = '{"deviceId":"mac-body","protocolVersion":2,"enrollmentCode":"';
        const suffix = '"}';
        const padLen = MAX_AGENT_JSON_BODY_BYTES - Buffer.byteLength(prefix + suffix);
        assert.ok(padLen > 0);
        return prefix + 'a'.repeat(padLen) + suffix;
      })();
      assert.equal(Buffer.byteLength(exactPayload), MAX_AGENT_JSON_BODY_BYTES);
      const exact = await local.postAgentRaw('/agent/enroll', exactPayload);
      assert.equal(exact.status, 401);
      assert.deepEqual(exact.body, { error: 'device-enrollment-invalid' });

      // 64 KiB + 1 via Content-Length — design §6.4 freezes unique 400 (not 413)
      const oversized = await local.postAgentRaw(
        '/agent/enroll',
        'x'.repeat(MAX_AGENT_JSON_BODY_BYTES + 1),
      );
      assertPublicError(oversized, 400, 'device-request-invalid');

      // declared Content-Length over limit with matching body (early reject path)
      const declaredBody = 'x'.repeat(MAX_AGENT_JSON_BODY_BYTES + 1);
      const declared = await local.requestAgent('POST', '/agent/enroll', {
        body: declaredBody,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(declaredBody)),
        },
      });
      assertPublicError(declared, 400, 'device-request-invalid');

      // chunked transfer oversize
      const chunkedOver = await local.requestAgent('POST', '/agent/enroll', {
        body: 'y'.repeat(MAX_AGENT_JSON_BODY_BYTES + 8),
        chunked: true,
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      });
      assertPublicError(chunkedOver, 400, 'device-request-invalid');

      const invalid = await local.postAgentRaw('/agent/enroll', '{broken');
      assertPublicError(invalid, 400, 'device-request-invalid');

      const empty = await local.postAgentRaw('/agent/enroll', '');
      assertPublicError(empty, 400, 'device-request-invalid');

      for (const raw of ['null', '[]', '"str"', '42', 'true']) {
        const bad = await local.postAgentRaw('/agent/enroll', raw);
        assertPublicError(bad, 400, 'device-request-invalid');
      }

      // connection still healthy after oversize
      const prep = await enrollFixture(local.registry, 'mac-after-oversize');
      const healthy = await local.postAgent('/agent/enroll', prep.enrollBody);
      assert.equal(healthy.status, 201);
    } finally {
      await local.cleanup();
    }
  });

  it('requires a single well-formed Bearer token and never echoes it', async () => {
    const local = await startAgentFixture();
    try {
      const { token } = await enrollViaHttps(local, 'mac-auth-header');
      const cases = [
        {},
        { headers: { authorization: 'Basic abc' } },
        { headers: { authorization: 'Bearer' } },
        { headers: { authorization: 'Bearer ' } },
        { headers: { authorization: 'bearer ' + token } },
        // multi-value / comma-joined Authorization (Node forbids raw CR/LF in headers)
        { headers: { authorization: `Bearer ${token}, Bearer ${token}` } },
        { headers: { authorization: 'Token ' + token } },
        { headers: { authorization: `Bearer ${token} trailing` } },
      ];
      for (const opts of cases) {
        const response = await local.requestAgent('POST', '/agent/heartbeat', {
          body: JSON.stringify({ deviceId: 'mac-auth-header', protocolVersion: 2 }),
          ...opts,
        });
        assertPublicError(response, 401, 'device-token-invalid');
        assertNoSecretEcho(response.raw, [token]);
      }
    } finally {
      await local.cleanup();
    }
  });

  it('rate-limits immediately without calling registry or onHeartbeat', async () => {
    let registryCalls = 0;
    let heartbeatCalls = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-rl-'));
    const registry = new DeviceRegistry({ dataDir });
    registry.consumeEnrollment = async () => {
      registryCalls += 1;
      throw new Error('should-not-run');
    };
    registry.authenticate = async () => {
      registryCalls += 1;
      throw new Error('should-not-run');
    };
    const limitedServer = await startAgentFixture({
      registry,
      onHeartbeat: async () => {
        heartbeatCalls += 1;
      },
      rateLimit: {
        check: () => ({ allowed: false, retryAfterMs: 1_000 }),
      },
    });
    try {
      const startedAt = Date.now();
      const limited = await limitedServer.postAgent('/agent/enroll', {
        deviceId: 'mac-limited',
        protocolVersion: 2,
        enrollmentCode: 'unused',
      });
      assertPublicError(limited, 429, 'device-rate-limited');
      assert.ok(Date.now() - startedAt < 500);
      assert.equal(registryCalls, 0);
      assert.equal(heartbeatCalls, 0);
      if (limited.headers['retry-after'] !== undefined) {
        assert.match(String(limited.headers['retry-after']), /^\d+$/);
      }
    } finally {
      await limitedServer.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fail-closes rateLimit decisions that are not strict boolean allow/deny', async () => {
    const invalidShapes = [
      undefined,
      null,
      {},
      { allowed: 0 },
      { allowed: 'false' },
      { allowed: 'true' },
      { allowed: 1 },
      Promise.resolve({ allowed: true }),
      { then: (resolve) => resolve({ allowed: true }) },
      [],
      true,
      false,
    ];

    for (const shape of invalidShapes) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-rl-shape-'));
      const registry = new DeviceRegistry({ dataDir });
      const counts = instrumentRegistry(registry);
      const local = await startAgentFixture({
        registry,
        onHeartbeat: async () => {
          counts.onHeartbeat += 1;
        },
        rateLimit: { check: () => shape },
      });
      try {
        const response = await local.postAgent('/agent/enroll', {
          deviceId: 'mac-rl-shape',
          protocolVersion: 2,
          enrollmentCode: 'unused-code-value',
        });
        assertPublicError(response, 500, 'device-internal-error');
        assert.equal(counts.consumeEnrollment, 0);
        assert.equal(counts.authenticate, 0);
        assert.equal(counts.beginTokenRotation, 0);
        assert.equal(counts.confirmTokenRotation, 0);
        assert.equal(counts.onHeartbeat, 0);
        assertNoSecretEcho(response.raw, ['unused-code-value']);
      } finally {
        await local.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }

    // strict allow continues; strict deny is 429 — both without registry side effects for deny
    {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-rl-allow-'));
      const registry = new DeviceRegistry({ dataDir });
      const counts = instrumentRegistry(registry);
      const local = await startAgentFixture({
        registry,
        onHeartbeat: async () => {
          counts.onHeartbeat += 1;
        },
        rateLimit: { check: () => ({ allowed: true }) },
      });
      try {
        const prep = await enrollFixture(registry, 'mac-rl-allow');
        const allowed = await local.postAgent('/agent/enroll', prep.enrollBody);
        assert.equal(allowed.status, 201);
        assert.equal(counts.consumeEnrollment, 1);
      } finally {
        await local.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }

    {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-rl-deny-'));
      const registry = new DeviceRegistry({ dataDir });
      const counts = instrumentRegistry(registry);
      const local = await startAgentFixture({
        registry,
        onHeartbeat: async () => {
          counts.onHeartbeat += 1;
        },
        rateLimit: {
          check: () => ({ allowed: false, retryAfterMs: 2500 }),
        },
      });
      try {
        const denied = await local.postAgent('/agent/enroll', {
          deviceId: 'mac-rl-deny',
          protocolVersion: 2,
          enrollmentCode: 'unused',
        });
        assertPublicError(denied, 429, 'device-rate-limited');
        assert.equal(counts.consumeEnrollment, 0);
        assert.equal(counts.onHeartbeat, 0);
        assert.equal(String(denied.headers['retry-after']), '3');
      } finally {
        await local.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });

  it('sanitizes rateLimit.check throws to device-internal-error', async () => {
    const limitedServer = await startAgentFixture({
      rateLimit: {
        check: () => {
          throw new Error('rate-limit secret /Users/private/key.pem leaked');
        },
      },
    });
    try {
      const response = await limitedServer.postAgent('/agent/enroll', {
        deviceId: 'mac-rl-throw',
        protocolVersion: 2,
        enrollmentCode: 'unused',
      });
      assertPublicError(response, 500, 'device-internal-error');
      assertNoSecretEcho(response.raw, ['rate-limit secret', '/Users/private/key.pem']);
    } finally {
      await limitedServer.cleanup();
    }
  });

  it('rejects real duplicate Authorization header lines via rawHeaders', async () => {
    const local = await startAgentFixture();
    try {
      const { token } = await enrollViaHttps(local, 'mac-dup-auth');
      const body = JSON.stringify({
        deviceId: 'mac-dup-auth',
        protocolVersion: 2,
      });
      const head = [
        'POST /agent/heartbeat HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        // First line is the valid device token; second must still fail closed.
        `Authorization: Bearer ${token}`,
        'Authorization: Bearer other-value',
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      const result = await rawTlsHttpExchange({
        port: local.port,
        head,
        bodyParts: [body],
        endAfterBody: true,
        timeoutMs: 800,
      });
      assert.equal(result.kind, 'response');
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { error: 'device-token-invalid' });
      assertNoSecretEcho(result.raw, [token, 'other-value']);
    } finally {
      await local.cleanup();
    }
  });

  it('returns 400 immediately when a chunked body crosses 64KiB without terminating chunk', async () => {
    const local = await startAgentFixture();
    try {
      const oversize = MAX_AGENT_JSON_BODY_BYTES + 1;
      const payload = 'x'.repeat(oversize);
      const chunkSizeHex = oversize.toString(16);
      const head = [
        'POST /agent/enroll HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      // One complete data chunk, intentionally no final 0\r\n\r\n terminator.
      const chunkFrame = `${chunkSizeHex}\r\n${payload}\r\n`;

      const startedAt = Date.now();
      const result = await rawTlsHttpExchange({
        port: local.port,
        head,
        bodyParts: [chunkFrame],
        endAfterBody: false,
        timeoutMs: 400,
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(result.kind, 'response', 'must not wait for client to finish the chunked stream');
      assert.ok(elapsed < 350, `expected fast 400, took ${elapsed}ms`);
      // Design §6.4: G0a oversize unique device-request-invalid status 400 (not 413).
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'device-request-invalid' });
    } finally {
      await local.cleanup();
    }
  });

  it('returns 404 immediately for unknown POST without awaiting body end', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-unknown-slow-'));
    const registry = new DeviceRegistry({ dataDir });
    const counts = instrumentRegistry(registry);
    const local = await startAgentFixture({
      registry,
      onHeartbeat: async () => {
        counts.onHeartbeat += 1;
      },
    });
    try {
      const head = [
        'POST /agent/unknown HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      // One incomplete chunked body fragment; never ends the request.
      const partial = '5\r\nhello';

      const startedAt = Date.now();
      const result = await rawTlsHttpExchange({
        port: local.port,
        head,
        bodyParts: [partial],
        endAfterBody: false,
        timeoutMs: 400,
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(result.kind, 'response', 'unknown route must not wait for body end');
      assert.ok(elapsed < 350, `expected fast 404, took ${elapsed}ms`);
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'device-route-not-found' });
      assert.equal(counts.consumeEnrollment, 0);
      assert.equal(counts.authenticate, 0);
      assert.equal(counts.beginTokenRotation, 0);
      assert.equal(counts.confirmTokenRotation, 0);
      assert.equal(counts.onHeartbeat, 0);
    } finally {
      await local.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes only whitelisted heartbeat fields and sanitizes callback failures', async () => {
    const seen = [];
    const local = await startAgentFixture({
      onHeartbeat: async (event) => {
        seen.push(event);
      },
    });
    try {
      const { token } = await enrollViaHttps(local, 'mac-hb-fields');
      const ok = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-hb-fields',
        protocolVersion: 2,
        hostname: 'host.local',
        secret: 'should-not-pass',
        extra: true,
      }, token);
      assert.equal(ok.status, 200);
      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0]).sort(), [
        'deviceId',
        'hostname',
        'remoteAddress',
      ]);
      assert.equal(seen[0].deviceId, 'mac-hb-fields');
      assert.equal(seen[0].hostname, 'host.local');
      assert.equal(typeof seen[0].remoteAddress, 'string');

      // default hostname
      const defaultHost = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-hb-fields',
        protocolVersion: 2,
      }, token);
      assert.equal(defaultHost.status, 200);
      assert.equal(seen[1].hostname, 'unknown');

      for (const hostname of ['', 'a'.repeat(256), 'bad\nhost', 'x\u0000y', 12, null]) {
        const bad = await local.postAgent('/agent/heartbeat', {
          deviceId: 'mac-hb-fields',
          protocolVersion: 2,
          hostname,
        }, token);
        assertPublicError(bad, 400, 'device-request-invalid');
      }
    } finally {
      await local.cleanup();
    }

    const throwing = await startAgentFixture({
      onHeartbeat: async () => {
        throw new Error('callback secret SYNTHETIC-KEY-MATERIAL path=/Users/private/token.pem');
      },
    });
    try {
      const { token } = await enrollViaHttps(throwing, 'mac-hb-throw');
      const response = await throwing.postAgent('/agent/heartbeat', {
        deviceId: 'mac-hb-throw',
        protocolVersion: 2,
      }, token);
      assertPublicError(response, 500, 'device-internal-error');
      assertNoSecretEcho(response.raw, [
        'SYNTHETIC-KEY-MATERIAL',
        '/Users/private/token.pem',
        'callback secret',
      ]);
    } finally {
      await throwing.cleanup();
    }
  });

  it('sanitizes registry throws and abnormal LinkeError status codes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-reg-err-'));
    const registry = new DeviceRegistry({ dataDir });
    const { ERROR_CODES, LinkeError } = await import('../src/error-codes.js');

    registry.consumeEnrollment = async () => {
      throw new Error('raw registry failure with /Users/secret/path and token=abc');
    };
    let local = await startAgentFixture({ registry });
    try {
      const raw = await local.postAgent('/agent/enroll', {
        deviceId: 'mac-reg-raw',
        protocolVersion: 2,
        enrollmentCode: 'x'.repeat(43),
      });
      assertPublicError(raw, 500, 'device-internal-error');
      assertNoSecretEcho(raw.raw, ['/Users/secret/path', 'token=abc']);
    } finally {
      await local.cleanup();
    }

    registry.consumeEnrollment = async () => {
      throw new LinkeError(ERROR_CODES.DEVICE_ENROLLMENT_INVALID, { statusCode: 999 });
    };
    local = await startAgentFixture({ registry });
    try {
      const weird = await local.postAgent('/agent/enroll', {
        deviceId: 'mac-reg-status',
        protocolVersion: 2,
        enrollmentCode: 'y'.repeat(43),
      });
      assert.equal(weird.body.error, 'device-enrollment-invalid');
      assert.ok(weird.status >= 400 && weird.status <= 599);
      assert.notEqual(weird.status, 999);
    } finally {
      await local.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serves HTTPS business traffic and rejects plain HTTP / TLS1.1', async () => {
    const local = await startAgentFixture();
    try {
      const prep = await enrollFixture(local.registry, 'mac-tls');
      const viaHttps = await local.postAgent('/agent/enroll', prep.enrollBody);
      assert.equal(viaHttps.status, 201);

      // plain HTTP must not yield a device business response
      const httpResult = await new Promise((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port: local.port,
          path: '/agent/enroll',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '2' },
          timeout: 1500,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              kind: 'response',
              status: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        });
        req.on('error', (error) => resolve({ kind: 'error', code: error.code, message: error.message }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ kind: 'timeout' });
        });
        req.end('{}');
      });
      if (httpResult.kind === 'response') {
        assert.notEqual(httpResult.status, 201);
        assert.doesNotMatch(httpResult.body, /deviceToken|device-enrollment/);
      } else {
        assert.ok(httpResult.kind === 'error' || httpResult.kind === 'timeout');
      }

      // TLSv1.1 should not be accepted when server minVersion is TLSv1.2
      const tls11 = await new Promise((resolve) => {
        const socket = tls.connect({
          host: '127.0.0.1',
          port: local.port,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.1',
          maxVersion: 'TLSv1.1',
          timeout: 1500,
        }, () => {
          socket.end();
          resolve({ kind: 'connected' });
        });
        socket.on('error', (error) => resolve({ kind: 'error', code: error.code }));
        socket.on('timeout', () => {
          socket.destroy();
          resolve({ kind: 'timeout' });
        });
      });
      assert.notEqual(tls11.kind, 'connected');
    } finally {
      await local.cleanup();
    }
  });

  it('never echoes enrollment codes, tokens or private key material', async () => {
    const local = await startAgentFixture();
    try {
      const secretCode = 'private-enrollment-value-SYNTH-01';
      const response = await local.postAgent('/agent/enroll', {
        deviceId: 'mac-alpha',
        protocolVersion: 2,
        enrollmentCode: secretCode,
      });
      assertNoSecretEcho(response.raw, [secretCode, local.identity.keyPem]);
      assert.equal(response.body.error, 'device-enrollment-invalid');
      assert.equal(Object.keys(response.body).join(','), 'error');
    } finally {
      await local.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// C6 extensions: G0a 15s total fake timer, single-settle, upload isolation
// ---------------------------------------------------------------------------

/**
 * Manual timer harness for G0a total deadline tests (no real 15s sleep).
 * Injected as createAgentListener({ timers }).
 */
function createManualTimers(startMs = 5_000_000) {
  let nowMs = startMs;
  let nextId = 1;
  /** @type {Map<number, { id: number, fireAt: number, fn: Function, args: any[], cleared: boolean }>} */
  const pending = new Map();
  return {
    now: () => nowMs,
    setTimeout(fn, ms, ...args) {
      const id = nextId;
      nextId += 1;
      const delay = Number(ms);
      const safeDelay = Number.isFinite(delay) && delay >= 0 ? delay : 0;
      pending.set(id, {
        id,
        fireAt: nowMs + safeDelay,
        fn,
        args,
        cleared: false,
      });
      return id;
    },
    clearTimeout(id) {
      const entry = pending.get(id);
      if (entry) entry.cleared = true;
      pending.delete(id);
    },
    advance(ms) {
      nowMs += ms;
      const due = [...pending.values()]
        .filter((e) => !e.cleared && e.fireAt <= nowMs)
        .sort((a, b) => a.id - b.id);
      for (const entry of due) {
        if (entry.cleared) continue;
        pending.delete(entry.id);
        entry.fn(...entry.args);
      }
    },
    pendingCount() {
      return [...pending.values()].filter((e) => !e.cleared).length;
    },
  };
}

/**
 * Wait until the handler has armed enough manual timers before advance().
 * TLS/HTTP delivery can lag a single setImmediate; poll via bounded
 * setImmediate + microtask barriers only (no wall-clock sleep).
 * @param {{ pendingCount: () => number }} timers
 * @param {{ minPending?: number, maxTurns?: number }} [opts]
 */
async function waitForTimerArmed(timers, { minPending = 1, maxTurns = 64 } = {}) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (timers.pendingCount() >= minPending) return;
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
  assert.ok(
    timers.pendingCount() >= minPending,
    `expected >=${minPending} armed timer(s) before advance, got ${timers.pendingCount()} after ${maxTurns} turns`,
  );
}

describe('C6 G0a deadline + upload isolation (RED)', () => {
  it('G0a enroll 15s total deadline → unique device-request-invalid 400 (fake timers)', async () => {
    const timers = createManualTimers();
    const local = await startAgentFixture({ timers });
    try {
      assert.equal(local.server.requestTimeout, 0);
      const body = JSON.stringify({
        deviceId: 'mac-deadline',
        protocolVersion: 2,
        enrollmentCode: 'x'.repeat(43),
      });
      const head = [
        'POST /agent/enroll HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const resultPromise = rawTlsHttpExchange({
        port: local.port,
        head,
        bodyParts: [body.slice(0, 10)],
        endAfterBody: false,
        timeoutMs: 1500,
      });
      await waitForTimerArmed(timers, { minPending: 1 });
      timers.advance(15_000 + 1);
      const result = await resultPromise;
      // RED without total timer: exchange times out (kind=timeout) or wrong status.
      assert.equal(result.kind, 'response', 'handler total timer must settle JSON error (not hang)');
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'device-request-invalid' });
    } finally {
      await local.cleanup();
    }
  });

  it('G0a late data/end after total deadline single-settles; no second response', async () => {
    const timers = createManualTimers();
    const local = await startAgentFixture({ timers });
    try {
      const body = JSON.stringify({
        deviceId: 'mac-late-settle',
        protocolVersion: 2,
        enrollmentCode: 'y'.repeat(43),
      });
      const head = [
        'POST /agent/enroll HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const resultPromise = rawTlsHttpExchange({
        port: local.port,
        head,
        bodyParts: [body.slice(0, 4)],
        endAfterBody: false,
        timeoutMs: 1500,
      });
      await waitForTimerArmed(timers, { minPending: 1 });
      timers.advance(15_001);
      const result = await resultPromise;
      assert.equal(result.kind, 'response', 'must single-settle before client wait bound');
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'device-request-invalid' });
      const errorMatches = result.raw.match(/"error"/g) || [];
      assert.equal(errorMatches.length, 1, 'must single-settle one JSON error body');
    } finally {
      await local.cleanup();
    }
  });

  it('uploadRateLimit is isolated from legacy rateLimit; G0a never counts as upload', async () => {
    let legacy = 0;
    let upload = 0;
    const local = await startAgentFixture({
      rateLimit: {
        check: () => {
          legacy += 1;
          return { allowed: true };
        },
      },
      uploadRateLimit: {
        check: () => {
          upload += 1;
          return { allowed: false, retryAfterMs: 1000 };
        },
      },
    });
    try {
      const prep = await enrollFixture(local.registry, 'mac-lim-iso');
      const enrolled = await local.postAgent('/agent/enroll', prep.enrollBody);
      assert.equal(enrolled.status, 201);
      assert.ok(legacy >= 1);
      assert.equal(upload, 0, 'G0a enroll must not hit upload limiter');
    } finally {
      await local.cleanup();
    }
  });

  it('without uploadService, typical /agent/upload/* paths stay fixed 404 on real TLS', async () => {
    const local = await startAgentFixture();
    try {
      const paths = [
        ['POST', '/agent/upload/sessions'],
        ['GET', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
        ['POST', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/chunks'],
        ['POST', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/finalize'],
        ['POST', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/abort'],
      ];
      for (const [method, path] of paths) {
        const res = await local.requestAgent(method, path, {
          body: method === 'GET' ? undefined : '{}',
          headers: {
            authorization: `Bearer ${'t'.repeat(43)}`,
            'x-linke-device-id': 'mac-x',
            'x-linke-protocol-version': '2',
            'content-type': 'application/json',
          },
        });
        assertPublicError(res, 404, 'device-route-not-found');
      }
      // requestTimeout remains 0 even without upload service.
      assert.equal(local.server.requestTimeout, 0);
      assert.equal(local.server.headersTimeout, 10_000);
    } finally {
      await local.cleanup();
    }
  });

  it('G0a heartbeat/rotate still work under requestTimeout=0 with 64KiB bound', async () => {
    const local = await startAgentFixture();
    try {
      assert.equal(local.server.requestTimeout, 0);
      const { token } = await enrollViaHttps(local, 'mac-g0a-still');
      const hb = await local.postAgent('/agent/heartbeat', {
        deviceId: 'mac-g0a-still',
        protocolVersion: 2,
        hostname: 'still.local',
      }, token);
      assert.equal(hb.status, 200);
      assert.deepEqual(hb.body, { deviceId: 'mac-g0a-still', accepted: true });

      const over = await local.postAgentRaw(
        '/agent/heartbeat',
        'z'.repeat(MAX_AGENT_JSON_BODY_BYTES + 1),
        { token },
      );
      assertPublicError(over, 400, 'device-request-invalid');
    } finally {
      await local.cleanup();
    }
  });

  it('complete uploadService without complete uploadRateLimit stays 404; G0a enroll untouched', async () => {
    // P1-b / G0a isolation: half-wired upload surface must not open routes or steal G0a traffic.
    let uploadServiceCalls = 0;
    const uploadService = {
      create: async () => {
        uploadServiceCalls += 1;
        return { uploadId: 'x', status: 'initialized' };
      },
      status: async () => {
        uploadServiceCalls += 1;
        return { uploadId: 'x', status: 'initialized' };
      },
      putChunk: async () => {
        uploadServiceCalls += 1;
        return { acked: true };
      },
      finalize: async () => {
        uploadServiceCalls += 1;
        return { uploadId: 'x', status: 'committed' };
      },
      abort: async () => {
        uploadServiceCalls += 1;
        return { uploadId: 'x', status: 'aborted' };
      },
    };
    let legacy = 0;
    const local = await startAgentFixture({
      uploadService,
      // intentionally omit complete uploadRateLimit
      rateLimit: {
        check: () => {
          legacy += 1;
          return { allowed: true };
        },
      },
    });
    try {
      const prep = await enrollFixture(local.registry, 'mac-lim-gate');
      const enrolled = await local.postAgent('/agent/enroll', prep.enrollBody);
      assert.equal(enrolled.status, 201, 'G0a enroll must still work');
      assert.ok(legacy >= 1, 'G0a must still hit legacy rateLimit');

      const up = await local.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify({
          manifest: { schemaVersion: 2 },
          manifestDigest: 'a'.repeat(64),
        }),
        headers: {
          authorization: `Bearer ${'t'.repeat(43)}`,
          'x-linke-device-id': 'mac-lim-gate',
          'x-linke-protocol-version': '2',
          'content-type': 'application/json',
        },
      });
      assertPublicError(up, 404, 'device-route-not-found');
      assert.equal(uploadServiceCalls, 0, 'upload service must not be touched without complete limiter');
    } finally {
      await local.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// C6 G0c restore isolation (RED): third limiter bucket + dual-gate surface
// ---------------------------------------------------------------------------

describe('C6 G0c restore isolation on agent-listener (RED)', () => {
  it('without restoreService, all /agent/restore/* paths stay fixed 404 on real TLS', async () => {
    const local = await startAgentFixture({
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const paths = [
        ['POST', '/agent/restore/tasks/claim'],
        ['GET', '/agent/restore/tasks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
        ['GET', '/agent/restore/tasks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/files/0/chunks/0'],
        ['POST', '/agent/restore/tasks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/progress'],
        ['POST', '/agent/restore/tasks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/receipts'],
        ['POST', '/agent/restore/tasks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/cleanup'],
      ];
      for (const [method, path] of paths) {
        const res = await local.requestAgent(method, path, {
          body: method === 'GET' ? undefined : '{}',
          headers: {
            authorization: `Bearer ${'t'.repeat(43)}`,
            'x-linke-device-id': 'mac-x',
            'x-linke-protocol-version': '2',
            'content-type': 'application/json',
          },
        });
        assertPublicError(res, 404, 'device-route-not-found');
      }
      assert.equal(local.server.requestTimeout, 0);
      assert.equal(local.server.headersTimeout, 10_000);
    } finally {
      await local.cleanup();
    }
  });

  it('complete restoreService without complete restoreRateLimit stays 404; G0a enroll untouched', async () => {
    let restoreServiceCalls = 0;
    const restoreService = {
      claim: async () => {
        restoreServiceCalls += 1;
        return { task: null };
      },
      getTask: async () => {
        restoreServiceCalls += 1;
        return { taskId: 'x' };
      },
      getChunk: async () => {
        restoreServiceCalls += 1;
        return { body: Buffer.alloc(0), headers: {} };
      },
      updateProgress: async () => {
        restoreServiceCalls += 1;
        return { ok: true, cancelRequested: false };
      },
      acceptReceipt: async () => {
        restoreServiceCalls += 1;
        return { ok: true, status: 'completed', cleanupAuthorized: true };
      },
      acceptCleanup: async () => {
        restoreServiceCalls += 1;
        return { ok: true, status: 'cleaned' };
      },
    };
    let legacy = 0;
    let restoreLimiter = 0;
    const local = await startAgentFixture({
      restoreService,
      // intentionally omit complete restoreRateLimit
      rateLimit: {
        check: () => {
          legacy += 1;
          return { allowed: true };
        },
      },
      restoreRateLimit: {
        // incomplete: check not a function shape is already covered elsewhere;
        // here we pass a full check but also test missing-gate by overriding below for claim.
        check: () => {
          restoreLimiter += 1;
          return { allowed: true };
        },
      },
    });
    // Re-open without restoreRateLimit for the dual-gate pin.
    await local.cleanup();
    const local2 = await startAgentFixture({
      restoreService,
      rateLimit: {
        check: () => {
          legacy += 1;
          return { allowed: true };
        },
      },
    });
    try {
      const prep = await enrollFixture(local2.registry, 'mac-rs-lim-gate');
      const enrolled = await local2.postAgent('/agent/enroll', prep.enrollBody);
      assert.equal(enrolled.status, 201, 'G0a enroll must still work');
      assert.ok(legacy >= 1, 'G0a must still hit legacy rateLimit');

      const claim = await local2.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: {
          authorization: `Bearer ${'t'.repeat(43)}`,
          'x-linke-device-id': 'mac-rs-lim-gate',
          'x-linke-protocol-version': '2',
          'content-type': 'application/json',
        },
      });
      assertPublicError(claim, 404, 'device-route-not-found');
      assert.equal(restoreServiceCalls, 0, 'restore service must not run without complete dual-gate');
      assert.equal(restoreLimiter, 0, 'restore limiter must not run when routes unmatched');
    } finally {
      await local2.cleanup();
    }
  });

  it('restoreRateLimit is isolated from legacy rateLimit and uploadRateLimit', async () => {
    let legacy = 0;
    let upload = 0;
    let restore = 0;
    const restoreService = {
      claim: async () => ({ task: null }),
      getTask: async () => ({ taskId: 't' }),
      getChunk: async () => ({
        body: Buffer.from('x'),
        headers: {
          contentType: 'application/octet-stream',
          contentLength: 1,
          taskId: 't',
          fileIndex: 0,
          chunkIndex: 0,
          chunkOffset: 0,
          chunkSize: 1,
          chunkSha256: 'a'.repeat(64),
        },
      }),
      updateProgress: async () => ({ ok: true, cancelRequested: false }),
      acceptReceipt: async () => ({
        ok: true,
        taskId: 't',
        status: 'completed',
        cleanupAuthorized: true,
        receiptId: 'r',
      }),
      acceptCleanup: async () => ({
        ok: true,
        taskId: 't',
        status: 'cleaned',
        cleanupId: 'c',
        cleanupAckAt: '2026-07-23T00:00:00.000Z',
      }),
    };
    const local = await startAgentFixture({
      restoreService,
      rateLimit: {
        check: () => {
          legacy += 1;
          return { allowed: true };
        },
      },
      uploadRateLimit: {
        check: () => {
          upload += 1;
          return { allowed: true };
        },
      },
      restoreRateLimit: {
        check: () => {
          restore += 1;
          return { allowed: true };
        },
      },
    });
    try {
      const prep = await enrollFixture(local.registry, 'mac-rs-iso');
      const enrolled = await local.postAgent('/agent/enroll', prep.enrollBody);
      assert.equal(enrolled.status, 201);
      assert.ok(legacy >= 1);
      const legacyAfterEnroll = legacy;
      assert.equal(upload, 0);
      assert.equal(restore, 0);

      assert.equal(typeof enrolled.body.deviceToken, 'string');
      const claim = await local.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: {
          authorization: `Bearer ${enrolled.body.deviceToken}`,
          'x-linke-device-id': 'mac-rs-iso',
          'x-linke-protocol-version': '2',
          'content-type': 'application/json',
        },
      });
      // Complete dual-gate MUST match restore routes (RED until C6 GREEN wires them).
      assert.equal(claim.status, 200, 'complete restore dual-gate must expose claim');
      assert.deepEqual(claim.body, { task: null });
      assert.equal(restore, 1, 'only restoreRateLimit bucket may count restore traffic');
      assert.equal(upload, 0, 'uploadRateLimit must stay isolated');
      assert.equal(legacy, legacyAfterEnroll, 'legacy rateLimit must stay isolated');
    } finally {
      await local.cleanup();
    }
  });
});
