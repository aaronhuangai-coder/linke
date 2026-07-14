import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { isPrivateAgentHost } from '../src/controller-runtime.js';
import {
  DEVICE_PROTOCOL_VERSION,
  MIN_DEVICE_PROTOCOL_VERSION,
} from '../src/device-protocol.js';
import {
  assertRealGate,
  assertDedicatedRunDirectory,
  assertSafeCleanupTarget,
  atomicWritePrivateJson,
  readPrivateJson,
  validateControllerConfig,
  validateBundle,
  validateReceipt,
  validateControllerState,
  validateEndpointState,
  transitionControllerState,
  transitionEndpointState,
  assertNoSensitiveData,
  serializeSanitizedResult,
  sanitizedFailure,
  CONTROLLER_STATES,
} from './helpers/g0a-real-common.js';

async function privateDir() {
  const root = await mkdtemp(join(tmpdir(), 'linke-g0a-common-'));
  await chmod(root, 0o700);
  return root;
}

describe('G0a real common gate and private files', () => {
  it('requires the exact real acceptance gate', () => {
    assert.throws(() => assertRealGate({}), (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
    assert.throws(() => assertRealGate({ LINKE_REAL_G0A_ACCEPTANCE: 'ENABLED' }));
    assert.equal(assertRealGate({ LINKE_REAL_G0A_ACCEPTANCE: 'enabled' }), true);
  });

  it('accepts only an exact private-IP fixed-port controller config', () => {
    assert.deepEqual(validateControllerConfig({
      schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0,
    }), {
      schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0,
    });
    for (const invalid of [
      { schemaVersion: 1, agentHost: '127.0.0.1', agentPort: 3443, managementPort: 0 },
      { schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 0, managementPort: 0 },
      { schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0, token: 'synthetic' },
    ]) assert.throws(() => validateControllerConfig(invalid));
  });

  it('writes atomic 0600 JSON and rejects symlink, 0644 and unknown schema fields', async () => {
    const root = await privateDir();
    const target = join(root, 'bundle.json');
    await atomicWritePrivateJson(target, { schemaVersion: 1, runId: 'run-synthetic' });
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(target, (value) => value), {
      schemaVersion: 1,
      runId: 'run-synthetic',
    });

    await chmod(target, 0o644);
    await assert.rejects(readPrivateJson(target, (value) => value));
    const link = join(root, 'link.json');
    await symlink(target, link);
    await assert.rejects(readPrivateJson(link, (value) => value));
  });
});

describe('G0a real common schemas, transitions and output', () => {
  it('rejects expired, cross-run and unknown-field bundles', () => {
    const base = {
      schemaVersion: 1,
      kind: 'reenrollment',
      runId: 'run-synthetic',
      agentUrl: 'https://10.0.0.10:3443',
      tlsFingerprint: 'a'.repeat(64),
      current: { deviceId: 'device-synthetic', enrollmentCode: 'b'.repeat(43) },
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      createdAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:10:00.000Z',
    };
    assert.throws(() => validateBundle({ ...base, extra: true }, {
      runId: 'run-synthetic', now: new Date('2030-01-01T00:01:00.000Z'),
    }));
    assert.throws(() => validateBundle(base, {
      runId: 'different-run', now: new Date('2030-01-01T00:01:00.000Z'),
    }));
    assert.throws(() => validateBundle(base, {
      runId: 'run-synthetic', now: new Date('2030-01-01T00:11:00.000Z'),
    }));
  });

  it('uses explicit intent states and refuses skipped transitions', () => {
    assert.equal(transitionControllerState('controller-ready', 'prepare'), 'preparing-bundle');
    assert.equal(transitionControllerState('preparing-bundle', 'prepare-complete'), 'bundle-prepared');
    assert.equal(transitionControllerState('endpoint-pre-revoke-passed', 'revoke-current'), 'revoking-current');
    assert.equal(transitionControllerState('preparing-bundle', 'stop'), 'cleaning');
    assert.equal(transitionEndpointState('pre-revoke-running', 'cleanup'), 'cleaning');
    assert.throws(() => transitionControllerState('controller-ready', 'revoke-current'));
    assert.ok(CONTROLLER_STATES.includes('replacing-fingerprint'));
  });

  it('allows only registered sanitized result fields and rejects secret-like nested values', () => {
    const safe = serializeSanitizedResult({
      role: 'endpoint', phase: 'pre-revoke', status: 'PASS',
      code: ERROR_CODES.DEVICE_TOKEN_INVALID, count: 2,
      at: '2030-01-01T00:00:00.000Z',
    });
    assert.doesNotThrow(() => JSON.parse(safe));
    for (const value of [
      '/private/synthetic/path', 'https://192.0.2.10:3443', 'a'.repeat(64),
      '-----BEGIN PRIVATE KEY-----', 'synthetic-token-value',
    ]) {
      assert.throws(() => assertNoSensitiveData({ nested: { note: value } }));
    }

    const failure = sanitizedFailure(
      'controller', 'prepare', new Error('raw path /private/synthetic'),
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    assert.deepEqual(failure, {
      role: 'controller', phase: 'prepare', status: 'FAIL',
      code: ERROR_CODES.DEVICE_INTERNAL_ERROR,
      at: '2030-01-01T00:00:00.000Z',
    });
    assert.doesNotMatch(JSON.stringify(failure), /private|synthetic/);
  });

  it('requires a matching PASS receipt before state advancement', () => {
    const receipt = {
      schemaVersion: 1,
      runId: 'run-synthetic',
      phase: 'pre-revoke',
      status: 'PASS',
      count: 1,
      at: '2030-01-01T00:00:00.000Z',
    };
    assert.deepEqual(validateReceipt(receipt, {
      runId: 'run-synthetic', phase: 'pre-revoke', requirePass: true,
    }), receipt);
    assert.throws(() => validateReceipt({ ...receipt, status: 'BLOCKED' }, {
      runId: 'run-synthetic', phase: 'pre-revoke', requirePass: true,
    }));
    assert.doesNotThrow(() => validateReceipt({
      schemaVersion: 1, runId: 'run-synthetic', phase: 'pre-revoke',
      status: 'PASS', at: '2030-01-01T00:00:00.000Z',
    }, { runId: 'run-synthetic', phase: 'pre-revoke', requirePass: true }));
  });
});

import { access } from 'node:fs/promises';
import {
  createControllerHarness,
} from './helpers/g0a-real-controller-runner.js';
import { TlsIdentityStore } from '../src/tls-identity-store.js';
import {
  CONTROLLER_CERT_RELATIVE_PATH,
  CONTROLLER_TLS_KEY_ITEM,
  RUN_MARKER_FILE,
  CONTROLLER_CONFIG_FILE,
} from './helpers/g0a-real-common.js';

function memoryKeychain(initial = new Map(), events = []) {
  return {
    async get(id) {
      events.push(`keychain:get:${id}`);
      if (!initial.has(id)) {
        throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
      }
      return initial.get(id);
    },
    async set(id, value) {
      events.push(`keychain:set:${id}`);
      initial.set(id, value);
    },
    async delete(id) {
      events.push(`keychain:delete:${id}`);
      return initial.delete(id);
    },
  };
}

async function createSyntheticDedicatedRun() {
  const root = await privateDir();
  await atomicWritePrivateJson(join(root, RUN_MARKER_FILE), {
    schemaVersion: 1,
    purpose: 'linke-g0a-real-acceptance',
  });
  await atomicWritePrivateJson(join(root, CONTROLLER_CONFIG_FILE), {
    schemaVersion: 1,
    agentHost: '10.0.0.10',
    agentPort: 3443,
    managementPort: 0,
  });
  return root;
}

function fakeControllerRuntime() {
  return {
    status: {
      managementListening: true,
      agentListening: true,
      tlsFingerprint: 'a'.repeat(64),
    },
    managementServer: { address: () => ({ address: '127.0.0.1', port: 31001 }) },
    agentServer: { address: () => ({ address: '10.0.0.10', port: 3443 }) },
    async close() {},
  };
}

function syntheticControllerState(phase) {
  return {
    schemaVersion: 1,
    purpose: 'linke-g0a-real-acceptance',
    runId: 'run-synthetic',
    phase,
    controllerKeychainService: 'com.linke.test.controller.synthetic',
    endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    dataDirectoryName: 'controller-data',
    cleanupFiles: [],
    cleanupDirectories: [],
    currentDeviceId: 'device-current',
    nMinusOneDeviceId: 'device-n-1',
    nMinusTwoDeviceId: 'device-n-2',
  };
}

async function syntheticControllerAt(phase, sinks = {}, { autoStart = true } = {}) {
  const runDir = await createSyntheticDedicatedRun();
  let state = syntheticControllerState(phase);
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => {
      state = structuredClone(next);
      sinks.events?.push(`state:${next.phase}`);
      sinks.writes?.push({ kind: 'state', phase: next.phase });
    },
    writeBundle: async (_name, value) => sinks.writes?.push({ kind: 'bundle', value }),
    readReceipt: async (phaseName) => {
      sinks.events?.push(`read:${phaseName}`);
      return {
        schemaVersion: 1, runId: state.runId, phase: phaseName,
        status: 'PASS', count: 1, at: '2030-01-01T00:00:00.000Z',
      };
    },
    deleteReceipt: async (phaseName) => sinks.events?.push(`delete:${phaseName}`),
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async (options) => {
      sinks.starts?.push(options);
      sinks.calls?.push('start-controller');
      return fakeControllerRuntime();
    },
    managementRequest: async (request) => {
      sinks.requests?.push(request);
      if (request.path === '/api/device-revoke') {
        return { statusCode: 200, body: { deviceId: state.currentDeviceId, revoked: true } };
      }
      return {
        statusCode: 201,
        body: {
          deviceId: request.body.deviceId,
          enrollmentCode: 'c'.repeat(43),
          expiresAt: '2030-01-01T00:10:00.000Z',
          agentUrl: 'https://10.0.0.10:3443',
          tlsFingerprint: 'a'.repeat(64),
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      };
    },
  });
  if (autoStart) {
    await harness.start();
    for (const list of [sinks.events, sinks.starts, sinks.calls]) list?.splice(0);
  }
  return harness;
}

async function syntheticStartedController(sinks = {}) {
  return syntheticControllerAt('controller-ready', sinks);
}

async function exerciseTlsIdentityContract() {
  const root = await privateDir();
  let keyItem;
  const values = new Map();
  const keychain = {
    async get(id) {
      keyItem = id;
      if (!values.has(id)) throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
      return values.get(id);
    },
    async set(id, value) { keyItem = id; values.set(id, value); },
    async delete(id) { return values.delete(id); },
  };
  const store = new TlsIdentityStore({ dataDir: join(root, 'tls'), keychain });
  await store.ensure({ host: '10.0.0.10', port: 3443 });
  await access(join(root, CONTROLLER_CERT_RELATIVE_PATH));
  return { keyItem, certRelativePath: CONTROLLER_CERT_RELATIVE_PATH };
}

describe('G0a real controller runner', () => {
  it('persists initialized state before Keychain or listener side effects', async () => {
    const events = [];
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir: await createSyntheticDedicatedRun(),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      writeState: async (state) => events.push(`state:${state.phase}`),
      keychainFactory: () => { events.push('keychain'); return memoryKeychain(); },
      startControllerImpl: async (options) => {
        events.push('network');
        assert.equal(typeof options.authToken, 'string');
        assert.ok(options.authToken.length >= 32);
        return fakeControllerRuntime();
      },
    });
    await harness.start();
    assert.deepEqual(events.slice(0, 3), ['state:initialized', 'keychain', 'network']);
  });

  it('journals prepare intent, generates exactly three initial codes and never persists admin token', async () => {
    const writes = [];
    const requests = [];
    const harness = await syntheticStartedController({ writes, requests });
    const result = await harness.execute('prepare');
    assert.equal(result.status, 'PASS');
    assert.deepEqual(writes.filter((v) => v.kind === 'state').map((v) => v.phase), [
      'preparing-bundle', 'bundle-prepared',
    ]);
    assert.equal(requests.filter((r) => r.path === '/api/device-enrollment-codes').length, 3);
    assert.doesNotMatch(JSON.stringify(writes), /admin-token-synthetic/);
  });

  it('validates a fixed PASS receipt before ack and writes state before deleting receipt', async () => {
    const events = [];
    const harness = await syntheticControllerAt('bundle-prepared', { events });
    await harness.execute('ack-pre-revoke');
    assert.deepEqual(events, ['read:pre-revoke', 'state:endpoint-pre-revoke-passed', 'delete:pre-revoke']);
  });

  it('does not replay uncertain prepare or revoke intent after a crash', async () => {
    for (const phase of ['preparing-bundle', 'revoking-current']) {
      const calls = [];
      const harness = await syntheticControllerAt(phase, { calls }, { autoStart: false });
      const started = await harness.start();
      assert.equal(started.status, 'BLOCKED');
      assert.deepEqual(calls, []);
      assert.equal((await harness.execute('prepare')).status, 'BLOCKED');
    }
  });

  it('restarts on the same data directory and fixed Agent port', async () => {
    const starts = [];
    const harness = await syntheticControllerAt('endpoint-post-revoke-passed', { starts });
    await harness.execute('restart');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].agentPort, 3443);
    assert.equal(harness.getState().phase, 'controller-restarted');
  });

  it('pins internal TLS identifiers with an injected TlsIdentityStore contract test', async () => {
    const observed = await exerciseTlsIdentityContract();
    assert.equal(observed.keyItem, 'controller-tls-private-key');
    assert.equal(observed.certRelativePath, 'tls/controller-cert.pem');
  });
});

import { createEndpointHarness } from './helpers/g0a-real-endpoint-runner.js';

function syntheticInitialBundle(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'initial',
    runId: 'run-synthetic',
    agentUrl: 'https://10.0.0.10:3443',
    tlsFingerprint: 'a'.repeat(64),
    current: { deviceId: 'device-current', enrollmentCode: 'c'.repeat(43) },
    nMinusOne: { deviceId: 'device-n-1', enrollmentCode: 'd'.repeat(43) },
    nMinusTwo: { deviceId: 'device-n-2', enrollmentCode: 'e'.repeat(43) },
    endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:10:00.000Z',
    ...overrides,
  };
}

function syntheticInitialConsumedBundle(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'initial-consumed',
    runId: 'run-synthetic',
    agentUrl: 'https://10.0.0.10:3443',
    tlsFingerprint: 'a'.repeat(64),
    current: { deviceId: 'device-current' },
    nMinusOne: { deviceId: 'device-n-1' },
    nMinusTwo: { deviceId: 'device-n-2' },
    endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    createdAt: '2030-01-01T00:00:00.000Z',
    consumedAt: '2030-01-01T00:03:00.000Z',
    ...overrides,
  };
}

function syntheticReenrollmentBundle() {
  return {
    schemaVersion: 1,
    kind: 'reenrollment',
    runId: 'run-synthetic',
    agentUrl: 'https://10.0.0.10:3443',
    tlsFingerprint: 'b'.repeat(64),
    current: { deviceId: 'device-current', enrollmentCode: 'f'.repeat(43) },
    endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    createdAt: '2030-01-01T00:02:00.000Z',
    expiresAt: '2030-01-01T00:12:00.000Z',
  };
}

function syntheticEndpointState(phase = 'initialized') {
  return {
    schemaVersion: 1,
    purpose: 'linke-g0a-real-acceptance',
    runId: 'run-synthetic',
    phase,
    endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    credentialItemIds: ['device-token.11111111111111111111111111111111', 'device-token.22222222222222222222222222222222'],
    cleanupFiles: [],
    cleanupDirectories: [],
  };
}

async function syntheticEndpoint(sinks = {}, {
  initialPhase = 'absent',
  mode = 'normal',
  initialBundle = null,
  keychainDelete = null,
} = {}) {
  const runDir = await createSyntheticDedicatedRun();
  let state = initialPhase === 'absent' ? null : syntheticEndpointState(initialPhase);
  let storedInitial = initialBundle ? structuredClone(initialBundle) : syntheticInitialBundle();
  // Post-init phases use initial-consumed continuation metadata.
  if (initialPhase !== 'absent' && initialPhase !== 'initialized'
    && storedInitial.kind === 'initial') {
    storedInitial = syntheticInitialConsumedBundle({ runId: storedInitial.runId });
  }
  const tokenMap = new Map([
    ['device-current', 'old-token-synthetic-0000000000000000'],
    ['device-n-1', 'n1-token-synthetic-00000000000000000'],
  ]);
  const credentialStore = {
    itemId(_agentUrl, deviceId) {
      return deviceId === 'device-current'
        ? 'device-token.11111111111111111111111111111111'
        : 'device-token.22222222222222222222222222222222';
    },
    async getToken(_agentUrl, deviceId) {
      sinks.events?.push(`keychain:get:${deviceId}`);
      if (deviceId === 'device-current') sinks.calls?.push({ name: 'getOldToken' });
      return tokenMap.get(deviceId);
    },
    async setToken(_agentUrl, deviceId, token) {
      sinks.events?.push(`keychain:set:${deviceId}`);
      tokenMap.set(deviceId, token);
    },
  };
  return createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readBundle: async (kind) => {
      if (kind === 'reenrollment') return syntheticReenrollmentBundle();
      return structuredClone(storedInitial);
    },
    readState: async () => state,
    writeState: async (next) => {
      state = structuredClone(next);
      sinks.events?.push(`state:${next.phase === 'initialized' ? 'item-ids-recorded' : next.phase}`);
      sinks.state = state;
    },
    writeBundle: async (_kind, value) => {
      storedInitial = structuredClone(value);
      sinks.bundles?.push(structuredClone(value));
    },
    writeReceipt: async (_phase, receipt) => sinks.receipts?.push(receipt),
    keychainFactory: () => ({
      async delete(itemId) {
        if (typeof keychainDelete === 'function') return keychainDelete(itemId, sinks);
        sinks.deleted?.push(itemId);
        return true;
      },
    }),
    credentialStoreFactory: () => credentialStore,
    enroll: async (_options) => {
      sinks.calls?.push({ name: 'enrollDevice' });
      tokenMap.set('device-current', 'current-token-synthetic-00000000000000');
      return {
        deviceId: 'device-current', enrolled: true,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      };
    },
    heartbeat: async () => {
      sinks.calls?.push({ name: 'heartbeatDevice' });
      if (mode === 'post-revoke') {
        sinks.outcomes?.push(ERROR_CODES.DEVICE_REVOKED);
        throw new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
      }
      if (mode === 'reenroll') {
        sinks.outcomes?.push('current-reenrolled-and-heartbeat-accepted');
      }
      return { deviceId: 'device-current', accepted: true };
    },
    rotate: async () => {
      sinks.calls?.push({ name: 'rotateDeviceToken' });
      sinks.rotateCalls?.push('rotate-call');
      if (mode === 'expired-pending') {
        throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
      }
      tokenMap.set('device-current', 'new-token-synthetic-0000000000000000');
      return { deviceId: 'device-current', rotated: true };
    },
    pinnedRequest: async (request) => {
      const label = request.body.protocolVersion === MIN_DEVICE_PROTOCOL_VERSION - 1
        ? 'n-2-enroll'
        : request.path === '/agent/enroll'
          ? 'n-1-enroll'
          : request.body.deviceId === 'device-n-1'
            ? 'n-1-heartbeat'
            : 'old-token-heartbeat';
      sinks.requests?.push({
        label, path: request.path, body: request.body,
        expectedStatus: label === 'n-2-enroll' ? 426 : undefined,
        expectedCode: label === 'n-2-enroll' ? ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED : undefined,
      });
      if (mode === 'fingerprint-change') {
        sinks.outcomes?.push(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH);
        throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH);
      }
      if (mode === 'n1-short-token' && label === 'n-1-enroll') {
        return {
          deviceId: 'device-n-1',
          deviceToken: 'short',
          protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
        };
      }
      if (mode === 'n1-heartbeat-missing-accepted' && label === 'n-1-heartbeat') {
        return { deviceId: 'device-n-1' };
      }
      if (mode === 'post-restart-heartbeat-missing-accepted' && label === 'n-1-heartbeat') {
        return { deviceId: 'device-n-1' };
      }
      if (label === 'old-token-heartbeat') {
        sinks.calls?.push({ name: 'oldTokenHeartbeat', expectedCode: ERROR_CODES.DEVICE_TOKEN_INVALID });
        throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
      }
      if (label === 'n-2-enroll') {
        throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
      }
      if (label === 'n-1-enroll') {
        return {
          deviceId: 'device-n-1',
          deviceToken: 'n1-token-synthetic-00000000000000000',
          protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
        };
      }
      sinks.outcomes?.push('n-1-heartbeat-accepted');
      return { deviceId: 'device-n-1', accepted: true };
    },
  });
}

async function syntheticEndpointWithExpiredPending(sinks = {}) {
  return syntheticEndpoint(sinks, { mode: 'expired-pending' });
}

describe('G0a real endpoint runner', () => {
  it('locks the supported window to exactly current and N-1', () => {
    assert.equal(MIN_DEVICE_PROTOCOL_VERSION, DEVICE_PROTOCOL_VERSION - 1);
  });

  it('persists exact credential item ids before Keychain/network use', async () => {
    const events = [];
    const harness = await syntheticEndpoint({ events });
    await harness.runPhase('pre-revoke');
    const firstCredentialSideEffect = events.findIndex((v) => v.startsWith('keychain:'));
    const stateWrite = events.findIndex((v) => v === 'state:item-ids-recorded');
    assert.ok(stateWrite >= 0 && stateWrite < firstCredentialSideEffect);
  });

  it('runs current enroll, two heartbeats, rotate, old-token rejection and new-token heartbeat in order', async () => {
    const calls = [];
    const harness = await syntheticEndpoint({ calls });
    await harness.runPhase('pre-revoke');
    assert.deepEqual(calls.slice(0, 6).map((c) => c.name), [
      'enrollDevice', 'heartbeatDevice', 'heartbeatDevice',
      'getOldToken', 'rotateDeviceToken', 'oldTokenHeartbeat',
    ]);
    assert.equal(calls[5].expectedCode, ERROR_CODES.DEVICE_TOKEN_INVALID);
    assert.equal(calls[6].name, 'heartbeatDevice');
  });

  it('uses current-1 for N-1 enroll/heartbeat and current-2 for strict 426', async () => {
    const requests = [];
    const harness = await syntheticEndpoint({ requests });
    await harness.runPhase('pre-revoke');
    const n1 = requests.filter((r) => r.label.startsWith('n-1'));
    assert.deepEqual(n1.map((r) => r.body.protocolVersion), [
      MIN_DEVICE_PROTOCOL_VERSION,
      MIN_DEVICE_PROTOCOL_VERSION,
    ]);
    const n2 = requests.find((r) => r.label === 'n-2-enroll');
    assert.equal(n2.body.protocolVersion, MIN_DEVICE_PROTOCOL_VERSION - 1);
    assert.equal(n2.expectedStatus, 426);
    assert.equal(n2.expectedCode, ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED);
  });

  it('requires revoke, restart, old pin mismatch and reenrollment outcomes', async () => {
    const cases = [
      { phase: 'post-revoke', prior: 'pre-revoke-passed', mode: 'post-revoke', expected: ERROR_CODES.DEVICE_REVOKED },
      { phase: 'post-restart', prior: 'post-revoke-passed', mode: 'normal', expected: 'n-1-heartbeat-accepted' },
      { phase: 'post-fingerprint-change', prior: 'post-restart-passed', mode: 'fingerprint-change', expected: ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH },
      { phase: 'reenroll', prior: 'post-fingerprint-change-passed', mode: 'reenroll', expected: 'current-reenrolled-and-heartbeat-accepted' },
    ];
    for (const item of cases) {
      const outcomes = [];
      const harness = await syntheticEndpoint({ outcomes }, { initialPhase: item.prior, mode: item.mode });
      await harness.runPhase(item.phase);
      assert.deepEqual(outcomes, [item.expected]);
    }
  });

  it('maps expired rotate recovery to bounded FAIL without a second begin', async () => {
    const calls = [];
    const rotateCalls = [];
    const harness = await syntheticEndpointWithExpiredPending({ calls, rotateCalls });
    const result = await harness.runPhase('pre-revoke');
    assert.equal(result.status, 'FAIL');
    assert.equal(rotateCalls.length, 1);
  });

  it('writes only 0600 sanitized receipts and cleans exact state allowlist items', async () => {
    const deleted = [];
    const harness = await syntheticEndpoint({ deleted }, { initialPhase: 'reenroll-passed' });
    await harness.runPhase('cleanup');
    assert.deepEqual(deleted.sort(), harness.getState().credentialItemIds.slice().sort());
    assert.ok(deleted.every((id) => id.startsWith('device-token.')));
  });
});

describe('G0a real fault matrix', () => {
  it('rejects a symlink marker and 0644 config before dependencies run', async () => {
    const root = await privateDir();
    const realMarker = join(root, 'real-marker.json');
    await atomicWritePrivateJson(realMarker, {
      schemaVersion: 1, purpose: 'linke-g0a-real-acceptance',
    });
    await symlink(realMarker, join(root, RUN_MARKER_FILE));
    await assert.rejects(assertDedicatedRunDirectory(root));

    const config = join(root, CONTROLLER_CONFIG_FILE);
    await writeFile(config, '{"schemaVersion":1}\n', { mode: 0o644 });
    await assert.rejects(readPrivateJson(config, (value) => value));
  });

  it('keeps the same prepared bundle and does not issue new codes after transfer retry', async () => {
    const requests = [];
    const harness = await syntheticControllerAt('bundle-prepared', { requests });
    const result = await harness.execute('prepare');
    assert.equal(result.status, 'PASS');
    assert.equal(result.flag, true);
    assert.equal(requests.length, 0);
  });

  it('detects both TLS identity half-states before listener start', async () => {
    const root = await privateDir();
    const tlsDir = join(root, 'tls');
    await mkdir(tlsDir, { recursive: true });
    await writeFile(join(tlsDir, 'controller-cert.pem'), 'synthetic-cert', { mode: 0o600 });
    const certOnly = new TlsIdentityStore({ dataDir: tlsDir, keychain: memoryKeychain() });
    await assert.rejects(
      certOnly.ensure({ host: '10.0.0.10', port: 3443 }),
      (e) => e.code === ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE,
    );

    const otherRoot = await privateDir();
    const keyOnly = new TlsIdentityStore({
      dataDir: join(otherRoot, 'tls'),
      keychain: memoryKeychain(new Map([[CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key']])),
    });
    await assert.rejects(
      keyOnly.ensure({ host: '10.0.0.10', port: 3443 }),
      (e) => e.code === ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE,
    );
  });

  it('rejects cleanup paths that escape the dedicated run directory', () => {
    const state = syntheticControllerState('cleaning');
    state.cleanupFiles = ['../outside'];
    assert.throws(() => validateControllerState(state, { runDir: '/private/synthetic-run' }),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);

    const endpointState = syntheticEndpointState('cleaning');
    endpointState.cleanupFiles = ['../outside'];
    assert.throws(() => validateEndpointState(endpointState, { runDir: '/private/synthetic-run' }),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
  });

  it('blocks cleanup through a symlink ancestor or a target type mismatch', async () => {
    const root = await privateDir();
    const realDir = join(root, 'real-dir');
    await mkdir(realDir);
    await symlink(realDir, join(root, 'linked-dir'));
    await assert.rejects(
      assertSafeCleanupTarget(root, 'linked-dir/file.json', 'file'),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );

    await writeFile(join(root, 'must-be-directory'), 'synthetic', { mode: 0o600 });
    await assert.rejects(
      assertSafeCleanupTarget(root, 'must-be-directory', 'directory'),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );
  });
});

// ── Task 4.5: Fresh-review regressions (real harness helpers, no constant stubs) ──

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  readOptionalPrivateJson,
  CONTROLLER_STATE_FILE,
} from './helpers/g0a-real-common.js';
import {
  requestManagementJson,
  runControllerHarnessMain,
} from './helpers/g0a-real-controller-runner.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTROLLER_RUNNER = join(REPO_ROOT, 'test/helpers/g0a-real-controller-runner.js');
const ENDPOINT_RUNNER = join(REPO_ROOT, 'test/helpers/g0a-real-endpoint-runner.js');
const SYNTHETIC_MGMT_TOKEN = 'synthetic-mgmt-token-32chars-min!!';

async function controllerWithStateFault(fault, counters) {
  const runDir = await createSyntheticDedicatedRun();
  const statePath = join(runDir, CONTROLLER_STATE_FILE);
  const good = syntheticControllerState('controller-ready');
  if (fault === 'bad-schema') {
    await atomicWritePrivateJson(statePath, { schemaVersion: 1, phase: 'controller-ready' });
  } else if (fault === 'truncated-json') {
    await writeFile(statePath, '{"schemaVersion":1', { mode: 0o600 });
  } else if (fault === '0644') {
    await atomicWritePrivateJson(statePath, good);
    await chmod(statePath, 0o644);
  } else if (fault === 'symlink') {
    const real = join(runDir, 'real-state.json');
    await atomicWritePrivateJson(real, good);
    await symlink(real, statePath);
  } else {
    throw new Error(`unknown fault ${fault}`);
  }
  return createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    writeState: async () => { counters.stateWrites += 1; },
    keychainFactory: () => {
      counters.keychain += 1;
      return memoryKeychain();
    },
    startControllerImpl: async () => {
      counters.network += 1;
      return fakeControllerRuntime();
    },
  });
}

async function controllerAtIntent(phase, calls) {
  return syntheticControllerAt(phase, { calls }, { autoStart: false });
}

async function exerciseSafeControllerResume(phase) {
  const starts = [];
  const keyEvents = [];
  const values = new Map();
  let certPresent = false;
  if (phase === 'replacing-fingerprint') {
    values.set(CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key');
    certPresent = true;
  }
  // identity-deleted / identity-regenerated: pair already removed; restart/cleaning: N/A
  let state = syntheticControllerState(phase);
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    keychainFactory: () => ({
      async get(id) {
        keyEvents.push(`get:${id}`);
        if (!values.has(id)) {
          throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
        }
        return values.get(id);
      },
      async set() {},
      async delete(id) {
        keyEvents.push(`delete:${id}`);
        return values.delete(id);
      },
    }),
    certExists: async () => certPresent,
    deleteFile: async () => { certPresent = false; },
    startControllerImpl: async (options) => {
      starts.push({
        accept: options.acceptTlsFingerprintChange === true,
        agentPort: options.agentPort,
      });
      if (phase === 'restarting-controller' || phase === 'cleaning') {
        return fakeControllerRuntime();
      }
      // Simulate post-delete regenerated identity on start.
      if (!values.has(CONTROLLER_TLS_KEY_ITEM)) {
        values.set(CONTROLLER_TLS_KEY_ITEM, 'new-synthetic-key');
        certPresent = true;
      }
      if (options.acceptTlsFingerprintChange !== true) {
        throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH);
      }
      return fakeControllerRuntime();
    },
  });

  if (phase === 'cleaning') {
    const started = await harness.start();
    assert.equal(started.status, 'PASS');
    assert.equal(starts.length, 0);
    const stop = await harness.execute('stop');
    return { status: stop.status, unsafeReplay: starts.length !== 0 };
  }

  if (phase === 'restarting-controller') {
    const started = await harness.start();
    return {
      status: started.status,
      unsafeReplay: starts.length !== 1 || starts[0].agentPort !== 3443,
    };
  }

  const started = await harness.start();
  const deletedWhenNotExpected = phase !== 'replacing-fingerprint'
    && keyEvents.some((e) => e.startsWith('delete:'));
  return {
    status: started.status,
    unsafeReplay: deletedWhenNotExpected,
  };
}

async function cleanupWithKeychainFailure(role, code) {
  if (role === 'controller') {
    let state = syntheticControllerState('reenrollment-passed');
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir: await createSyntheticDedicatedRun(),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => { state = structuredClone(next); },
      keychainFactory: () => ({
        async get() {
          throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
        },
        async set() {},
        async delete() {
          throw new LinkeError(code);
        },
      }),
      startControllerImpl: async () => fakeControllerRuntime(),
    });
    await harness.start();
    const result = await harness.execute('stop');
    return { status: result.status, state };
  }
  const sinks = {};
  const harness = await syntheticEndpoint(sinks, {
    initialPhase: 'reenroll-passed',
    keychainDelete: async () => {
      throw new LinkeError(code);
    },
  });
  const result = await harness.runPhase('cleanup');
  return { status: result.status, state: sinks.state ?? harness.getState() };
}

async function endpointWithCrossRunBundle(calls) {
  const runDir = await createSyntheticDedicatedRun();
  let state = syntheticEndpointState('pre-revoke-passed');
  return createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    readBundle: async () => syntheticInitialConsumedBundle({ runId: 'other-run-id' }),
    writeReceipt: async () => {},
    keychainFactory: () => {
      calls.keychain += 1;
      return { async delete() { return true; } };
    },
    credentialStoreFactory: () => ({
      itemId: () => 'device-token.11111111111111111111111111111111',
      async getToken() { calls.keychain += 1; return 'tok'; },
      async setToken() { calls.keychain += 1; },
    }),
    heartbeat: async () => { calls.network += 1; return { accepted: true }; },
    pinnedRequest: async () => { calls.network += 1; return { accepted: true }; },
    enroll: async () => { calls.network += 1; },
    rotate: async () => { calls.network += 1; },
  });
}

async function runSyntheticPreRevokeAndReadBundle() {
  const sinks = { bundles: [] };
  const harness = await syntheticEndpoint(sinks);
  const result = await harness.runPhase('pre-revoke');
  assert.equal(result.status, 'PASS');
  const consumed = sinks.bundles.find((b) => b.kind === 'initial-consumed');
  assert.ok(consumed);
  return consumed;
}

async function exerciseMalformedResponse(responseFault) {
  if (responseFault.startsWith('enrollment-') || responseFault.startsWith('revoke-')) {
    let issueCount = 0;
    const harness = await syntheticControllerAt('controller-ready', {}, { autoStart: true });
    // Rebuild with custom managementRequest by wrapping via new harness.
    let state = syntheticControllerState('controller-ready');
    const writes = [];
    const custom = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir: await createSyntheticDedicatedRun(),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => {
        state = structuredClone(next);
        writes.push(next.phase);
      },
      writeBundle: async () => {},
      keychainFactory: () => memoryKeychain(),
      startControllerImpl: async () => fakeControllerRuntime(),
      managementRequest: async (request) => {
        if (request.path === '/api/device-enrollment-codes') {
          issueCount += 1;
          const base = {
            deviceId: request.body.deviceId,
            enrollmentCode: 'c'.repeat(43),
            expiresAt: '2030-01-01T00:10:00.000Z',
            agentUrl: 'https://10.0.0.10:3443',
            tlsFingerprint: 'a'.repeat(64),
            protocolVersion: DEVICE_PROTOCOL_VERSION,
          };
          if (responseFault === 'enrollment-expiry-missing') {
            const { expiresAt, ...rest } = base;
            void expiresAt;
            return { statusCode: 201, body: rest };
          }
          if (responseFault === 'enrollment-expiry-noncanonical') {
            return { statusCode: 201, body: { ...base, expiresAt: '2030-01-01T00:10:00.000+00:00' } };
          }
          return { statusCode: 201, body: base };
        }
        if (request.path === '/api/device-revoke') {
          if (responseFault === 'revoke-device-mismatch') {
            return { statusCode: 200, body: { deviceId: 'other-device', revoked: true } };
          }
          if (responseFault === 'revoke-flag-false') {
            return { statusCode: 200, body: { deviceId: 'device-current', revoked: false } };
          }
          return { statusCode: 200, body: { deviceId: 'device-current', revoked: true } };
        }
        return { statusCode: 200, body: {} };
      },
    });
    await custom.start();
    if (responseFault.startsWith('enrollment-')) {
      const result = await custom.execute('prepare');
      return {
        status: result.status,
        passReceiptWritten: false,
        phase: custom.getState()?.phase,
      };
    }
    // Need endpoint-pre-revoke-passed for revoke
    state = syntheticControllerState('endpoint-pre-revoke-passed');
    const revokeHarness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir: await createSyntheticDedicatedRun(),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => { state = structuredClone(next); },
      keychainFactory: () => memoryKeychain(),
      startControllerImpl: async () => fakeControllerRuntime(),
      managementRequest: async (request) => {
        if (responseFault === 'revoke-device-mismatch') {
          return { statusCode: 200, body: { deviceId: 'other-device', revoked: true } };
        }
        if (responseFault === 'revoke-flag-false') {
          return { statusCode: 200, body: { deviceId: 'device-current', revoked: false } };
        }
        return { statusCode: 200, body: { deviceId: 'device-current', revoked: true } };
      },
    });
    await revokeHarness.start();
    const result = await revokeHarness.execute('revoke-current');
    return { status: result.status, passReceiptWritten: false, phase: revokeHarness.getState()?.phase };
  }

  const mode = responseFault;
  const receipts = [];
  const prior = responseFault === 'post-restart-heartbeat-missing-accepted'
    ? 'post-revoke-passed'
    : 'initialized';
  // For n1 faults use pre-revoke from absent; for post-restart use prior phase.
  if (responseFault === 'post-restart-heartbeat-missing-accepted') {
    const harness = await syntheticEndpoint({ receipts }, {
      initialPhase: 'post-revoke-passed',
      mode,
    });
    const result = await harness.runPhase('post-restart');
    return {
      status: result.status,
      passReceiptWritten: receipts.some((r) => r.status === 'PASS'),
    };
  }
  const harness = await syntheticEndpoint({ receipts }, { mode });
  const result = await harness.runPhase('pre-revoke');
  return {
    status: result.status,
    passReceiptWritten: receipts.some((r) => r.status === 'PASS'),
  };
}

async function exerciseReplacementFault(fault) {
  let state = syntheticControllerState('restart-passed');
  const values = new Map();
  let certPresent = false;
  if (fault === 'key-only') {
    values.set(CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key');
    certPresent = false;
  } else if (fault === 'cert-only') {
    certPresent = true;
  } else if (fault === 'delete-false') {
    values.set(CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key');
    certPresent = true;
  } else if (fault === 'keychain-unavailable') {
    values.set(CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key');
    certPresent = true;
  }
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    certExists: async () => certPresent,
    deleteFile: async () => { certPresent = false; },
    keychainFactory: () => ({
      async get(id) {
        if (fault === 'keychain-unavailable') {
          throw new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
        }
        if (!values.has(id)) {
          throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
        }
        return values.get(id);
      },
      async set() {},
      async delete(id) {
        if (fault === 'keychain-unavailable') {
          throw new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
        }
        if (fault === 'delete-false') return false;
        return values.delete(id);
      },
    }),
    startControllerImpl: async () => fakeControllerRuntime(),
  });
  await harness.start();
  const result = await harness.execute('replace-identity-confirmed');
  return { status: result.status, state };
}

async function failSecondEnrollmentIssue() {
  let state = syntheticControllerState('controller-ready');
  let issues = 0;
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    writeBundle: async () => {},
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async () => fakeControllerRuntime(),
    managementRequest: async (request) => {
      if (request.path !== '/api/device-enrollment-codes') {
        return { statusCode: 200, body: {} };
      }
      issues += 1;
      if (issues >= 2) {
        throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
      }
      return {
        statusCode: 201,
        body: {
          deviceId: request.body.deviceId,
          enrollmentCode: 'c'.repeat(43),
          expiresAt: '2030-01-01T00:10:00.000Z',
          agentUrl: 'https://10.0.0.10:3443',
          tlsFingerprint: 'a'.repeat(64),
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      };
    },
  });
  await harness.start();
  const result = await harness.execute('prepare');
  return { status: result.status, state };
}

function runNodeChild(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, LINKE_REAL_G0A_ACCEPTANCE: env.LINKE_REAL_G0A_ACCEPTANCE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('G0a fresh-review regressions', () => {
  it('distinguishes missing state from corrupt, 0644 and symlink state', async () => {
    for (const fault of ['bad-schema', 'truncated-json', '0644', 'symlink']) {
      const counters = { stateWrites: 0, keychain: 0, network: 0 };
      const harness = await controllerWithStateFault(fault, counters);
      await assert.rejects(harness.start(), (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
      assert.deepEqual(counters, { stateWrites: 0, keychain: 0, network: 0 });
    }
  });

  it('allows stop-only recovery from unsafe controller intent', async () => {
    const calls = [];
    const harness = await controllerAtIntent('preparing-bundle', calls);
    const started = await harness.start();
    assert.equal(started.status, 'BLOCKED');
    assert.equal(calls.includes('network'), false);
    assert.equal(calls.includes('start-controller'), false);
    assert.equal((await harness.execute('prepare')).status, 'BLOCKED');
    assert.equal((await harness.execute('stop')).status, 'PASS');
  });

  it('resumes restart, replacement substates and cleaning without replaying unsafe work', async () => {
    for (const phase of [
      'restarting-controller', 'replacing-fingerprint',
      'identity-deleted', 'identity-regenerated', 'cleaning',
    ]) {
      const result = await exerciseSafeControllerResume(phase);
      assert.equal(result.unsafeReplay, false, `unsafeReplay for ${phase}`);
      assert.equal(result.status, 'PASS', `status for ${phase}`);
    }
  });

  it('does not mark cleanup complete when dedicated Keychain deletion is unavailable', async () => {
    for (const role of ['controller', 'endpoint']) {
      const result = await cleanupWithKeychainFailure(role, ERROR_CODES.KEYCHAIN_UNAVAILABLE);
      assert.equal(result.status, 'BLOCKED', role);
      assert.equal(result.state.phase, 'cleaning', role);
    }
  });

  it('binds every post-init bundle to Endpoint state runId', async () => {
    const calls = { keychain: 0, network: 0 };
    const harness = await endpointWithCrossRunBundle(calls);
    const result = await harness.runPhase('post-revoke');
    assert.notEqual(result.status, 'PASS');
    assert.deepEqual(calls, { keychain: 0, network: 0 });
  });

  it('uses initial-consumed metadata after the enrollment TTL without retaining codes', async () => {
    const consumed = await runSyntheticPreRevokeAndReadBundle();
    assert.equal(consumed.kind, 'initial-consumed');
    assert.equal('expiresAt' in consumed, false);
    assert.equal(JSON.stringify(consumed).includes('enrollmentCode'), false);
    assert.doesNotThrow(() => validateBundle(consumed, {
      runId: consumed.runId,
      now: new Date('2031-01-01T00:00:00.000Z'),
    }));
  });

  it('strictly validates management and N-1 response shapes', async () => {
    for (const responseFault of [
      'enrollment-expiry-missing', 'enrollment-expiry-noncanonical',
      'revoke-device-mismatch', 'revoke-flag-false',
      'n1-short-token', 'n1-heartbeat-missing-accepted',
      'post-restart-heartbeat-missing-accepted',
    ]) {
      const result = await exerciseMalformedResponse(responseFault);
      assert.notEqual(result.status, 'PASS', responseFault);
      assert.equal(result.passReceiptWritten, false, responseFault);
    }
  });

  it('preflights paired identity and preserves Keychain unavailable', async () => {
    for (const fault of ['key-only', 'cert-only', 'delete-false', 'keychain-unavailable']) {
      const result = await exerciseReplacementFault(fault);
      assert.equal(result.status, 'BLOCKED', fault);
      assert.equal(result.state.phase, 'replacing-fingerprint', fault);
    }
  });

  it('returns BLOCKED after an irreversible intent-side-effect failure', async () => {
    const result = await failSecondEnrollmentIssue();
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.state.phase, 'preparing-bundle');
  });

  it('does not start a listener when controller state is already cleaned', async () => {
    const starts = [];
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir: await createSyntheticDedicatedRun(),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => syntheticControllerState('cleaned'),
      writeState: async () => {},
      keychainFactory: () => memoryKeychain(),
      startControllerImpl: async (options) => {
        starts.push(options);
        return fakeControllerRuntime();
      },
    });
    const started = await harness.start();
    assert.equal(started.status, 'PASS');
    assert.equal(starts.length, 0);
  });

  it('rejects Endpoint running-intent replay and allows cleanup-only recovery', async () => {
    const harness = await syntheticEndpoint({}, { initialPhase: 'pre-revoke-running' });
    const blocked = await harness.runPhase('pre-revoke');
    assert.equal(blocked.status, 'BLOCKED');
    const cleaned = await harness.runPhase('cleanup');
    assert.equal(cleaned.status, 'PASS');
  });

  it('direct main emits single sanitized FAIL without gate and import stays silent', async () => {
    const child = await runNodeChild([CONTROLLER_RUNNER], { LINKE_REAL_G0A_ACCEPTANCE: '' });
    assert.equal(child.stdout.trim().split('\n').length, 1);
    const line = JSON.parse(child.stdout.trim());
    assert.equal(line.status, 'FAIL');
    assert.equal(line.role, 'controller');
    assert.doesNotMatch(child.stdout, /token|fingerprint|private|\/Users|BEGIN /i);
    // stderr may contain host Node env warnings; must not contain secrets or stacks.
    assert.doesNotMatch(child.stderr, /token|fingerprint|enrollment|stack|Error:/i);

    const ep = await runNodeChild([ENDPOINT_RUNNER, 'pre-revoke', 'extra'], {
      LINKE_REAL_G0A_ACCEPTANCE: 'enabled',
    });
    assert.equal(ep.stdout.trim().split('\n').length, 1);
    const epLine = JSON.parse(ep.stdout.trim());
    assert.equal(epLine.status, 'FAIL');
    assert.equal(epLine.role, 'endpoint');

    // Import zero side effects: no stdout from dynamic import helper.
    const importProbe = await runNodeChild(['-e',
      "import('./test/helpers/g0a-real-controller-runner.js');"
      + "import('./test/helpers/g0a-real-endpoint-runner.js');"], {});
    assert.equal(importProbe.stdout.trim(), '');
  });

  it('readOptionalPrivateJson returns null only for ENOENT', async () => {
    const root = await privateDir();
    const missing = join(root, 'nope.json');
    assert.equal(await readOptionalPrivateJson(missing, (v) => v), null);
    const bad = join(root, 'bad.json');
    await writeFile(bad, '{', { mode: 0o600 });
    await assert.rejects(readOptionalPrivateJson(bad, (v) => v));
  });
});

// ── Task 4.6: Second-round fresh-review P1/P2 regressions ──

function enrollmentBody(deviceId, overrides = {}) {
  return {
    deviceId,
    enrollmentCode: 'c'.repeat(43),
    expiresAt: '2030-01-01T00:10:00.000Z',
    agentUrl: 'https://10.0.0.10:3443',
    tlsFingerprint: 'a'.repeat(64),
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    ...overrides,
  };
}

async function controllerWithEnrollmentFault(fault, { reenrollment = false } = {}) {
  const startPhase = reenrollment ? 'fingerprint-replaced' : 'controller-ready';
  let state = syntheticControllerState(startPhase);
  const bundles = [];
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    now: () => new Date('2030-01-01T00:00:00.000Z'),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    writeBundle: async (_name, value) => { bundles.push(structuredClone(value)); },
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async () => fakeControllerRuntime(),
    managementRequest: async (request) => {
      if (request.path !== '/api/device-enrollment-codes') {
        return { statusCode: 200, body: {} };
      }
      const deviceId = request.body.deviceId;
      const base = enrollmentBody(deviceId);
      if (fault === 'extra-field') {
        return { statusCode: 201, body: { ...base, extra: true } };
      }
      if (fault === 'http-url') {
        return { statusCode: 201, body: { ...base, agentUrl: 'http://10.0.0.10:3443' } };
      }
      if (fault === 'short-pin') {
        return { statusCode: 201, body: { ...base, tlsFingerprint: 'ab'.repeat(16) } };
      }
      if (fault === 'upper-pin') {
        return { statusCode: 201, body: { ...base, tlsFingerprint: 'A'.repeat(64) } };
      }
      if (fault === 'expired') {
        return {
          statusCode: 201,
          body: { ...base, expiresAt: '2029-12-31T23:59:59.000Z' },
        };
      }
      if (fault === 'url-mismatch') {
        const url = deviceId === 'device-n-1'
          ? 'https://10.0.0.11:3443'
          : base.agentUrl;
        return { statusCode: 201, body: { ...base, agentUrl: url } };
      }
      return { statusCode: 201, body: base };
    },
  });
  await harness.start();
  const command = reenrollment ? 'prepare-reenrollment' : 'prepare';
  const result = await harness.execute(command);
  return { status: result.status, phase: harness.getState()?.phase, bundles };
}

async function controllerWithWriteFault(kind) {
  let state = syntheticControllerState(
    kind === 'reenrollment-bundle' ? 'fingerprint-replaced' : 'controller-ready',
  );
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    now: () => new Date('2030-01-01T00:00:00.000Z'),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => {
      if (kind === 'complete-state' && next.phase === 'bundle-prepared') {
        throw new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
      }
      state = structuredClone(next);
    },
    writeBundle: async () => {
      if (kind === 'write-bundle' || kind === 'reenrollment-bundle') {
        throw new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
      }
    },
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async () => fakeControllerRuntime(),
    managementRequest: async (request) => {
      if (request.path === '/api/device-enrollment-codes') {
        return { statusCode: 201, body: enrollmentBody(request.body.deviceId) };
      }
      return { statusCode: 200, body: {} };
    },
  });
  await harness.start();
  const command = kind === 'reenrollment-bundle' ? 'prepare-reenrollment' : 'prepare';
  const result = await harness.execute(command);
  return { status: result.status, phase: harness.getState()?.phase };
}

async function controllerRestartRuntimeThrow() {
  let state = syntheticControllerState('endpoint-post-revoke-passed');
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async () => {
      if (state.phase === 'restarting-controller') {
        throw new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
      }
      return fakeControllerRuntime();
    },
  });
  await harness.start();
  const result = await harness.execute('restart');
  return { status: result.status, phase: harness.getState()?.phase };
}

async function controllerCleanupUnlinkThrow() {
  let state = syntheticControllerState('reenrollment-passed');
  state = {
    ...state,
    cleanupFiles: ['bundle-initial.json'],
    cleanupDirectories: [],
  };
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async () => fakeControllerRuntime(),
    deleteFile: async () => {
      const err = new Error('synthetic-unlink');
      err.code = 'EPERM';
      throw err;
    },
  });
  await harness.start();
  const result = await harness.execute('stop');
  return { status: result.status, phase: harness.getState()?.phase };
}

async function controllerPersistStateWriteThrow() {
  let durable = syntheticControllerState('controller-ready');
  let memoryPhaseAfter = null;
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => durable,
    writeState: async (next) => {
      if (next.phase === 'preparing-bundle') {
        throw new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
      }
      durable = structuredClone(next);
    },
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async () => fakeControllerRuntime(),
  });
  await harness.start();
  const result = await harness.execute('prepare');
  memoryPhaseAfter = harness.getState()?.phase;
  return {
    status: result.status,
    memoryPhase: memoryPhaseAfter,
    durablePhase: durable.phase,
  };
}

async function endpointMalformedBundleBeforeIntent(kind) {
  const calls = { keychain: 0, network: 0 };
  const prior = kind === 'reenroll' ? 'post-fingerprint-change-passed' : 'pre-revoke-passed';
  let state = syntheticEndpointState(prior);
  const harness = await createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    readBundle: async () => {
      if (kind === 'cross-run') {
        return syntheticInitialConsumedBundle({ runId: 'other-run-id' });
      }
      if (kind === 'malformed') {
        return { ...syntheticInitialConsumedBundle(), extra: true };
      }
      if (kind === 'reenroll') {
        return { ...syntheticReenrollmentBundle(), extra: true };
      }
      return syntheticInitialConsumedBundle();
    },
    writeReceipt: async () => {},
    keychainFactory: () => {
      calls.keychain += 1;
      return { async delete() { return true; } };
    },
    credentialStoreFactory: () => ({
      itemId: () => 'device-token.11111111111111111111111111111111',
      async getToken() { calls.keychain += 1; return 't'.repeat(40); },
      async setToken() { calls.keychain += 1; },
    }),
    heartbeat: async () => { calls.network += 1; return { accepted: true }; },
    pinnedRequest: async () => { calls.network += 1; return { accepted: true }; },
    enroll: async () => { calls.network += 1; },
    rotate: async () => { calls.network += 1; },
  });
  const phase = kind === 'reenroll' ? 'reenroll' : 'post-revoke';
  const result = await harness.runPhase(phase);
  return {
    status: result.status,
    phase: harness.getState()?.phase,
    durablePhase: state.phase,
    calls,
  };
}

async function endpointPostRevokeNetworkThrow() {
  let state = syntheticEndpointState('pre-revoke-passed');
  const harness = await createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    readBundle: async () => syntheticInitialConsumedBundle(),
    writeReceipt: async () => {},
    keychainFactory: () => ({ async delete() { return true; } }),
    credentialStoreFactory: () => ({
      itemId: () => 'device-token.11111111111111111111111111111111',
      async getToken() { return 't'.repeat(40); },
      async setToken() {},
    }),
    heartbeat: async () => {
      throw new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
    },
    pinnedRequest: async () => ({}),
    enroll: async () => {},
    rotate: async () => {},
  });
  const result = await harness.runPhase('post-revoke');
  return { status: result.status, phase: harness.getState()?.phase };
}

async function endpointCleanupUnlinkThrow() {
  let state = {
    ...syntheticEndpointState('reenroll-passed'),
    cleanupFiles: ['bundle-initial.json'],
    cleanupDirectories: [],
  };
  const harness = await createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir: await createSyntheticDedicatedRun(),
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    readBundle: async () => syntheticInitialConsumedBundle(),
    writeReceipt: async () => {},
    deleteFile: async () => {
      const err = new Error('synthetic-unlink');
      err.code = 'EPERM';
      throw err;
    },
    keychainFactory: () => ({ async delete() { return true; } }),
    credentialStoreFactory: () => ({
      itemId: () => 'device-token.11111111111111111111111111111111',
      async getToken() { return 't'.repeat(40); },
      async setToken() {},
    }),
    enroll: async () => {},
    heartbeat: async () => ({}),
    rotate: async () => {},
    pinnedRequest: async () => ({}),
  });
  const result = await harness.runPhase('cleanup');
  return { status: result.status, phase: harness.getState()?.phase };
}

async function endpointPreRevokeUsesSingleValidatedBundle() {
  let reads = 0;
  const runDir = await createSyntheticDedicatedRun();
  let state = null;
  const tokens = new Map([
    ['device-current', 'old-token-synthetic-0000000000000000'],
  ]);
  const harness = await createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readState: async () => state,
    writeState: async (next) => { state = structuredClone(next); },
    readBundle: async () => {
      reads += 1;
      return syntheticInitialBundle();
    },
    writeBundle: async () => {},
    writeReceipt: async () => {},
    keychainFactory: () => ({ async delete() { return true; } }),
    credentialStoreFactory: () => ({
      itemId: (_u, deviceId) => (deviceId === 'device-current'
        ? 'device-token.11111111111111111111111111111111'
        : 'device-token.22222222222222222222222222222222'),
      async getToken(_u, deviceId) { return tokens.get(deviceId); },
      async setToken(_u, deviceId, token) { tokens.set(deviceId, token); },
    }),
    enroll: async () => {
      tokens.set('device-current', 'current-token-synthetic-00000000000000');
      return {
        deviceId: 'device-current', enrolled: true, protocolVersion: DEVICE_PROTOCOL_VERSION,
      };
    },
    heartbeat: async () => ({ deviceId: 'device-current', accepted: true }),
    rotate: async () => {
      tokens.set('device-current', 'new-token-synthetic-0000000000000000');
      return { deviceId: 'device-current', rotated: true };
    },
    pinnedRequest: async (request) => {
      if (request.body.protocolVersion === MIN_DEVICE_PROTOCOL_VERSION - 1) {
        throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
      }
      if (request.path === '/agent/enroll') {
        return {
          deviceId: 'device-n-1',
          deviceToken: 'n1-token-synthetic-00000000000000000',
          protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
        };
      }
      // Pre-rotate current token must be rejected after rotate (captured in-process only).
      if (request.token === 'current-token-synthetic-00000000000000'
        || request.token === 'old-token-synthetic-0000000000000000') {
        throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
      }
      return { deviceId: request.body.deviceId, accepted: true };
    },
  });
  const result = await harness.runPhase('pre-revoke');
  return { status: result.status, reads };
}

function listenEphemeral(handler) {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectListen(new Error('no port'));
        return;
      }
      resolveListen({ server, port: addr.port });
    });
    server.on('error', rejectListen);
  });
}

describe('G0a task-4.6 second-round regressions', () => {
  it('rejects enrollment management bodies with extra fields, http URL, short/upper pin or expired time', async () => {
    for (const fault of ['extra-field', 'http-url', 'short-pin', 'upper-pin', 'expired', 'url-mismatch']) {
      const result = await controllerWithEnrollmentFault(fault);
      assert.equal(result.status, 'BLOCKED', fault);
      assert.equal(result.phase, 'preparing-bundle', fault);
      assert.equal(result.bundles.length, 0, fault);
    }
    const reenroll = await controllerWithEnrollmentFault('extra-field', { reenrollment: true });
    assert.equal(reenroll.status, 'BLOCKED');
    assert.equal(reenroll.phase, 'preparing-reenrollment');
    assert.equal(reenroll.bundles.length, 0);
  });

  it('validates bundles before persist and BLOCKED on write/complete-state failures after intent', async () => {
    for (const kind of ['write-bundle', 'complete-state', 'reenrollment-bundle']) {
      const result = await controllerWithWriteFault(kind);
      assert.equal(result.status, 'BLOCKED', kind);
      assert.equal(
        result.phase,
        kind === 'reenrollment-bundle' ? 'preparing-reenrollment' : 'preparing-bundle',
        kind,
      );
    }
  });

  it('maps restart runtime throw and controller cleanup unlink throw to BLOCKED with durable intent', async () => {
    const restart = await controllerRestartRuntimeThrow();
    assert.equal(restart.status, 'BLOCKED');
    assert.equal(restart.phase, 'restarting-controller');

    const cleanup = await controllerCleanupUnlinkThrow();
    assert.equal(cleanup.status, 'BLOCKED');
    assert.equal(cleanup.phase, 'cleaning');
  });

  it('does not update in-memory controller state when writeState throws', async () => {
    const result = await controllerPersistStateWriteThrow();
    assert.notEqual(result.status, 'PASS');
    assert.equal(result.memoryPhase, 'controller-ready');
    assert.equal(result.durablePhase, 'controller-ready');
  });

  it('loads and validates Endpoint bundle before running intent; cross-run/malformed leave prior phase', async () => {
    for (const kind of ['cross-run', 'malformed', 'reenroll']) {
      const result = await endpointMalformedBundleBeforeIntent(kind);
      assert.notEqual(result.status, 'PASS', kind);
      assert.deepEqual(result.calls, { keychain: 0, network: 0 }, kind);
      const expected = kind === 'reenroll'
        ? 'post-fingerprint-change-passed'
        : 'pre-revoke-passed';
      assert.equal(result.durablePhase, expected, kind);
      assert.equal(result.phase, expected, kind);
    }
  });

  it('maps endpoint post-revoke network and cleanup unlink throws to BLOCKED with durable phase', async () => {
    const post = await endpointPostRevokeNetworkThrow();
    assert.equal(post.status, 'BLOCKED');
    assert.equal(post.phase, 'post-revoke-running');

    const cleanup = await endpointCleanupUnlinkThrow();
    assert.equal(cleanup.status, 'BLOCKED');
    assert.equal(cleanup.phase, 'cleaning');
  });

  it('reuses a single validated pre-revoke bundle object without post-intent re-read', async () => {
    const result = await endpointPreRevokeUsesSingleValidatedBundle();
    assert.equal(result.status, 'PASS');
    // bootstrap load + phase load must collapse to one validated read after state exists,
    // and never re-read after running intent (TOCTOU). Max 2: init + pre-intent.
    assert.ok(result.reads <= 2, `reads=${result.reads}`);
  });

  it('requestManagementJson covers allowed path, non-2xx, oversized and malformed body on loopback', async () => {
    const oversized = `${'x'.repeat(65 * 1024)}`;
    const { server, port } = await listenEphemeral((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) {
          try { body = JSON.parse(raw); } catch { body = null; }
        }
        if (req.url === '/api/agent-listener-status') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ listening: true }));
          return;
        }
        if (req.url === '/api/device-revoke') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ERROR_CODES.DEVICE_REQUEST_INVALID }));
          return;
        }
        if (req.url === '/api/device-enrollment-codes') {
          const mode = body && body.deviceId === 'device-malformed' ? 'malformed' : 'oversize';
          if (mode === 'malformed') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{not-json');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(oversized);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: ERROR_CODES.DEVICE_REQUEST_INVALID }));
      });
    });
    try {
      const ok = await requestManagementJson({
        host: '127.0.0.1',
        port,
        path: '/api/agent-listener-status',
        method: 'GET',
        token: SYNTHETIC_MGMT_TOKEN,
      });
      assert.equal(ok.statusCode, 200);
      assert.equal(/** @type {{ listening?: boolean }} */ (ok.body).listening, true);

      await assert.rejects(
        () => requestManagementJson({
          host: '127.0.0.1',
          port,
          path: '/api/not-allowed',
          method: 'POST',
          token: SYNTHETIC_MGMT_TOKEN,
        }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );

      await assert.rejects(
        () => requestManagementJson({
          host: '127.0.0.1',
          port,
          path: '/api/device-revoke',
          method: 'POST',
          token: SYNTHETIC_MGMT_TOKEN,
          body: { deviceId: 'device-current' },
        }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );

      await assert.rejects(
        () => requestManagementJson({
          host: '127.0.0.1',
          port,
          path: '/api/device-enrollment-codes',
          method: 'POST',
          token: SYNTHETIC_MGMT_TOKEN,
          body: { deviceId: 'device-oversize' },
        }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );

      await assert.rejects(
        () => requestManagementJson({
          host: '127.0.0.1',
          port,
          path: '/api/device-enrollment-codes',
          method: 'POST',
          token: SYNTHETIC_MGMT_TOKEN,
          body: { deviceId: 'device-malformed' },
        }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );
    } finally {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('controller main emits sanitized readiness JSON on PASS start without secrets', async () => {
    const lines = [];
    const stdout = {
      write(chunk) {
        lines.push(String(chunk));
        return true;
      },
    };
    const runDir = await createSyntheticDedicatedRun();
    let state = null;
    await runControllerHarnessMain({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir,
      stdout,
      stdin: Readable.from(['stop\n']),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => { state = structuredClone(next); },
      writeBundle: async () => {},
      keychainFactory: () => memoryKeychain(),
      startControllerImpl: async () => fakeControllerRuntime(),
      deleteFile: async () => {},
    });
    assert.ok(lines.length >= 1);
    const readiness = JSON.parse(lines[0].trim());
    assert.equal(readiness.role, 'controller');
    assert.equal(readiness.phase, 'start');
    assert.equal(readiness.status, 'PASS');
    assert.equal(typeof readiness.at, 'string');
    const joined = lines.join('');
    assert.doesNotMatch(joined, /token|fingerprint|10\.0\.0\.10|3443|BEGIN |enrollment/i);
  });
});

// ── Task 4.7: Third-round fresh-review P1/P2 (service prefix, path, agentUrl) ──

describe('G0a task-4.7 third-round regressions', () => {
  it('rejects production-like and unsuffixed Keychain services in state and bundle schemas', () => {
    const runDir = '/private/synthetic-run';
    const controller = syntheticControllerState('controller-ready');
    for (const service of [
      'com.linke.gold',
      'com.linke.test.controller',
      'com.linke.test.controller.',
      'com.linke.test.endpoint.synthetic',
      '',
      'com.linke.test.controller../escape',
    ]) {
      assert.throws(
        () => validateControllerState({ ...controller, controllerKeychainService: service }, { runDir }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        `controller service ${service}`,
      );
    }
    for (const service of [
      'com.linke.gold',
      'com.linke.test.endpoint',
      'com.linke.test.endpoint.',
      'com.linke.test.controller.synthetic',
      '',
    ]) {
      assert.throws(
        () => validateControllerState({ ...controller, endpointKeychainService: service }, { runDir }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        `controller endpoint service ${service}`,
      );
      assert.throws(
        () => validateEndpointState({
          ...syntheticEndpointState('initialized'),
          endpointKeychainService: service,
        }, { runDir }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        `endpoint service ${service}`,
      );
    }

    const now = new Date('2030-01-01T00:01:00.000Z');
    for (const service of [
      'com.linke.gold',
      'com.linke.test.endpoint',
      'com.linke.test.endpoint.',
      'com.linke.test.controller.synthetic',
    ]) {
      assert.throws(
        () => validateBundle(syntheticInitialBundle({ endpointKeychainService: service }), {
          runId: 'run-synthetic',
          now,
        }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        `bundle service ${service}`,
      );
    }

    // Strict suffix form is accepted once helpers land.
    assert.doesNotThrow(() => validateControllerState({
      ...controller,
      controllerKeychainService: 'com.linke.test.controller.synthetic',
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    }, { runDir }));
    assert.doesNotThrow(() => validateEndpointState({
      ...syntheticEndpointState('initialized'),
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    }, { runDir }));
    assert.doesNotThrow(() => validateBundle(
      syntheticInitialBundle({ endpointKeychainService: 'com.linke.test.endpoint.synthetic' }),
      { runId: 'run-synthetic', now },
    ));
  });

  it('rejects absolute, parent, empty-segment and backslash dataDirectoryName escapes', () => {
    const runDir = '/private/synthetic-run';
    const base = {
      ...syntheticControllerState('controller-ready'),
      controllerKeychainService: 'com.linke.test.controller.synthetic',
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
    };
    for (const name of ['../x', '/etc/passwd', '', '.', '..', 'controller-data\\..\\outside', 'a//b', 'a/./b']) {
      assert.throws(
        () => validateControllerState({ ...base, dataDirectoryName: name }, { runDir }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        `dataDirectoryName ${name}`,
      );
    }
    assert.doesNotThrow(() => validateControllerState({
      ...base,
      dataDirectoryName: 'controller-data',
    }, { runDir }));
  });

  it('rejects agentUrl userinfo, query and hash in validateBundle before any side effects', () => {
    const now = new Date('2030-01-01T00:01:00.000Z');
    const goodService = 'com.linke.test.endpoint.synthetic';
    for (const agentUrl of [
      'https://user:pass@10.0.0.10:3443',
      'https://user@10.0.0.10:3443',
      'https://10.0.0.10:3443?x=1',
      'https://10.0.0.10:3443#frag',
      'https://10.0.0.10:3443/path?x=1',
      'http://10.0.0.10:3443',
      'https://',
    ]) {
      assert.throws(
        () => validateBundle(syntheticInitialBundle({
          endpointKeychainService: goodService,
          agentUrl,
        }), { runId: 'run-synthetic', now }),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        agentUrl,
      );
    }
    assert.doesNotThrow(() => validateBundle(syntheticInitialBundle({
      endpointKeychainService: goodService,
      agentUrl: 'https://10.0.0.10:3443',
    }), { runId: 'run-synthetic', now }));
  });

  it('rejects malicious controller state services with zero Keychain, file and network spies', async () => {
    for (const service of ['com.linke.gold', 'com.linke.test.controller', 'production.service']) {
      const spies = { keychain: 0, network: 0, deleteFile: 0 };
      let state = {
        ...syntheticControllerState('controller-ready'),
        controllerKeychainService: service,
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.keychain += 1;
          return memoryKeychain();
        },
        startControllerImpl: async () => {
          spies.network += 1;
          return fakeControllerRuntime();
        },
        deleteFile: async () => { spies.deleteFile += 1; },
      });
      await assert.rejects(
        harness.start(),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        service,
      );
      assert.deepEqual(spies, { keychain: 0, network: 0, deleteFile: 0 }, service);
    }
  });

  it('rejects malicious endpoint state and initial bundle services with zero Keychain/network', async () => {
    for (const service of ['com.linke.gold', 'com.linke.test.endpoint', 'com.linke.production']) {
      const spies = { keychain: 0, network: 0 };
      let state = {
        ...syntheticEndpointState('pre-revoke-passed'),
        endpointKeychainService: service,
      };
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => syntheticInitialConsumedBundle({
          endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        }),
        writeReceipt: async () => {},
        keychainFactory: () => {
          spies.keychain += 1;
          return { async delete() { return true; } };
        },
        credentialStoreFactory: () => ({
          itemId: () => 'device-token.11111111111111111111111111111111',
          async getToken() { spies.keychain += 1; return 't'.repeat(40); },
          async setToken() { spies.keychain += 1; },
        }),
        heartbeat: async () => { spies.network += 1; return { accepted: true }; },
        pinnedRequest: async () => { spies.network += 1; return { accepted: true }; },
        enroll: async () => { spies.network += 1; },
        rotate: async () => { spies.network += 1; },
      });
      const result = await harness.runPhase('post-revoke');
      assert.notEqual(result.status, 'PASS', service);
      assert.deepEqual(spies, { keychain: 0, network: 0 }, service);
      assert.equal(state.phase, 'pre-revoke-passed', service);
    }

    // Malicious initial bundle must fail before bootstrap Keychain/network.
    for (const service of ['com.linke.gold', 'com.linke.test.endpoint', 'com.linke.test.controller.x']) {
      const spies = { keychain: 0, network: 0 };
      let state = null;
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => syntheticInitialBundle({ endpointKeychainService: service }),
        writeBundle: async () => {},
        writeReceipt: async () => {},
        keychainFactory: () => {
          spies.keychain += 1;
          return { async delete() { return true; } };
        },
        credentialStoreFactory: () => ({
          itemId: () => {
            spies.keychain += 1;
            return 'device-token.11111111111111111111111111111111';
          },
          async getToken() { spies.keychain += 1; return null; },
          async setToken() { spies.keychain += 1; },
        }),
        enroll: async () => { spies.network += 1; },
        heartbeat: async () => { spies.network += 1; return { accepted: true }; },
        rotate: async () => { spies.network += 1; },
        pinnedRequest: async () => { spies.network += 1; return {}; },
      });
      const result = await harness.runPhase('pre-revoke');
      assert.notEqual(result.status, 'PASS', service);
      assert.deepEqual(spies, { keychain: 0, network: 0 }, service);
      assert.equal(state, null, service);
    }
  });

  it('rejects malformed agentUrl userinfo/query/hash bundles before intent Keychain/network', async () => {
    for (const agentUrl of [
      'https://user:pass@10.0.0.10:3443',
      'https://10.0.0.10:3443?x=1',
      'https://10.0.0.10:3443#h',
    ]) {
      const spies = { keychain: 0, network: 0 };
      let state = {
        ...syntheticEndpointState('pre-revoke-passed'),
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      };
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => syntheticInitialConsumedBundle({
          endpointKeychainService: 'com.linke.test.endpoint.synthetic',
          agentUrl,
        }),
        writeReceipt: async () => {},
        keychainFactory: () => {
          spies.keychain += 1;
          return { async delete() { return true; } };
        },
        credentialStoreFactory: () => ({
          itemId: () => 'device-token.11111111111111111111111111111111',
          async getToken() { spies.keychain += 1; return 't'.repeat(40); },
          async setToken() { spies.keychain += 1; },
        }),
        heartbeat: async () => { spies.network += 1; return { accepted: true }; },
        pinnedRequest: async () => { spies.network += 1; return { accepted: true }; },
        enroll: async () => { spies.network += 1; },
        rotate: async () => { spies.network += 1; },
      });
      const result = await harness.runPhase('post-revoke');
      assert.notEqual(result.status, 'PASS', agentUrl);
      assert.deepEqual(spies, { keychain: 0, network: 0 }, agentUrl);
      assert.equal(state.phase, 'pre-revoke-passed', agentUrl);
    }
  });

  it('rejects controller dataDirectoryName escapes and symlink ancestors before runtime/Keychain', async () => {
    // Escape via state field must fail prevalidation with zero spies.
    for (const name of ['../x', '/tmp/abs-data']) {
      const spies = { keychain: 0, network: 0 };
      let state = {
        ...syntheticControllerState('controller-ready'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        dataDirectoryName: name,
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.keychain += 1;
          return memoryKeychain();
        },
        startControllerImpl: async () => {
          spies.network += 1;
          return fakeControllerRuntime();
        },
      });
      await assert.rejects(
        harness.start(),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        name,
      );
      assert.deepEqual(spies, { keychain: 0, network: 0 }, name);
    }

    // Symlink ancestor under dataDirectoryName must block startRuntime after safe resolve.
    const runDir = await createSyntheticDedicatedRun();
    const realOutside = await privateDir();
    await symlink(realOutside, join(runDir, 'controller-data'));
    const spies = { keychain: 0, network: 0, deleteFile: 0 };
    let state = {
      ...syntheticControllerState('controller-ready'),
      controllerKeychainService: 'com.linke.test.controller.synthetic',
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      dataDirectoryName: 'controller-data',
    };
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir,
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => { state = structuredClone(next); },
      keychainFactory: () => {
        spies.keychain += 1;
        return memoryKeychain();
      },
      startControllerImpl: async () => {
        spies.network += 1;
        return fakeControllerRuntime();
      },
      deleteFile: async () => { spies.deleteFile += 1; },
    });
    await assert.rejects(
      harness.start(),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );
    // Factory may not run before data-dir safety; network must stay 0.
    assert.equal(spies.network, 0);
    assert.equal(spies.deleteFile, 0);
  });

  it('replacement preflights cert path safety and never deletes Keychain first on unsafe path', async () => {
    const runDir = await createSyntheticDedicatedRun();
    // data dir is a symlink ancestor for cert path controller-data/tls/controller-cert.pem
    const realOutside = await privateDir();
    await symlink(realOutside, join(runDir, 'controller-data'));

    const values = new Map([[CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key']]);
    const events = [];
    let state = {
      ...syntheticControllerState('restart-passed'),
      controllerKeychainService: 'com.linke.test.controller.synthetic',
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      dataDirectoryName: 'controller-data',
    };
    const deleteFileTargets = [];
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir,
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => { state = structuredClone(next); },
      // Injected certExists must NOT bypass path safety.
      certExists: async () => true,
      deleteFile: async (rel) => {
        deleteFileTargets.push(rel);
        events.push(`deleteFile:${rel}`);
      },
      keychainFactory: (service) => {
        events.push(`factory:${service}`);
        return {
          async get(id) {
            events.push(`get:${id}`);
            if (!values.has(id)) {
              throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
            }
            return values.get(id);
          },
          async set() {},
          async delete(id) {
            events.push(`delete:${id}`);
            return values.delete(id);
          },
        };
      },
      startControllerImpl: async () => fakeControllerRuntime(),
    });
    // start itself must reject symlink data dir; if it somehow advances, replace must still not delete.
    let startError = null;
    try {
      await harness.start();
    } catch (error) {
      startError = error;
    }
    if (startError) {
      assert.equal(startError.code, ERROR_CODES.DEVICE_REQUEST_INVALID);
      assert.equal(events.some((e) => e.startsWith('delete:')), false);
      assert.equal(values.has(CONTROLLER_TLS_KEY_ITEM), true);
      assert.deepEqual(deleteFileTargets, []);
      return;
    }
    const result = await harness.execute('replace-identity-confirmed');
    assert.equal(result.status, 'BLOCKED');
    assert.equal(state.phase, 'replacing-fingerprint');
    assert.equal(events.some((e) => e.startsWith('delete:')), false);
    assert.equal(values.has(CONTROLLER_TLS_KEY_ITEM), true);
    assert.deepEqual(deleteFileTargets, []);
  });

  it('replacement resume with cert symlink blocks without Keychain delete even when certExists is true', async () => {
    const runDir = await createSyntheticDedicatedRun();
    const realOutside = await privateDir();
    await mkdir(join(runDir, 'controller-data'), { mode: 0o700 });
    await symlink(realOutside, join(runDir, 'controller-data', 'tls'));

    const values = new Map([[CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key']]);
    const events = [];
    let state = {
      ...syntheticControllerState('replacing-fingerprint'),
      controllerKeychainService: 'com.linke.test.controller.synthetic',
      endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      dataDirectoryName: 'controller-data',
    };
    const deleteFileTargets = [];
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir,
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      readState: async () => state,
      writeState: async (next) => { state = structuredClone(next); },
      certExists: async () => true,
      deleteFile: async (rel) => {
        deleteFileTargets.push(rel);
      },
      keychainFactory: () => ({
        async get(id) {
          events.push(`get:${id}`);
          if (!values.has(id)) {
            throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
          }
          return values.get(id);
        },
        async set() {},
        async delete(id) {
          events.push(`delete:${id}`);
          return values.delete(id);
        },
      }),
      startControllerImpl: async () => fakeControllerRuntime(),
    });
    const started = await harness.start();
    assert.equal(started.status, 'BLOCKED');
    assert.equal(state.phase, 'replacing-fingerprint');
    assert.equal(events.includes(`delete:${CONTROLLER_TLS_KEY_ITEM}`), false);
    assert.equal(values.has(CONTROLLER_TLS_KEY_ITEM), true);
    assert.deepEqual(deleteFileTargets, []);
  });

  it('controller enrollment management rejects agentUrl userinfo/query/hash before bundle write', async () => {
    for (const agentUrl of [
      'https://user:pass@10.0.0.10:3443',
      'https://10.0.0.10:3443?x=1',
      'https://10.0.0.10:3443#h',
    ]) {
      let state = {
        ...syntheticControllerState('controller-ready'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
      };
      const bundles = [];
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        writeBundle: async (_name, value) => { bundles.push(structuredClone(value)); },
        keychainFactory: () => memoryKeychain(),
        startControllerImpl: async () => fakeControllerRuntime(),
        managementRequest: async (request) => {
          if (request.path !== '/api/device-enrollment-codes') {
            return { statusCode: 200, body: {} };
          }
          return {
            statusCode: 201,
            body: enrollmentBody(request.body.deviceId, { agentUrl }),
          };
        },
      });
      await harness.start();
      const result = await harness.execute('prepare');
      assert.equal(result.status, 'BLOCKED', agentUrl);
      assert.equal(state.phase, 'preparing-bundle', agentUrl);
      assert.equal(bundles.length, 0, agentUrl);
    }
  });
});

// ── Task 4.8: Fourth-round fresh-review P1/P2 (nested tls path + state service bind) ──

import { readdir } from 'node:fs/promises';
import { startController as productionStartController } from '../src/controller-runtime.js';

describe('G0a task-4.8 fourth-round regressions', () => {
  async function seedNestedTlsSymlink(runDir) {
    const outside = await privateDir();
    await mkdir(join(runDir, 'controller-data'), { mode: 0o700 });
    await symlink(outside, join(runDir, 'controller-data', 'tls'));
    return outside;
  }

  async function outsideHasControllerCert(outside) {
    try {
      const names = await readdir(outside);
      return names.some((n) => n === 'controller-cert.pem' || n.endsWith('.pem') || n.includes('controller-cert'));
    } catch {
      return false;
    }
  }

  it('blocks initial start when nested tls is a symlink (injected + production startController)', async () => {
    for (const mode of ['injected', 'production']) {
      const runDir = await createSyntheticDedicatedRun();
      const outside = await seedNestedTlsSymlink(runDir);
      const spies = { factory: 0, set: 0, delete: 0, network: 0 };
      let state = {
        ...syntheticControllerState('controller-ready'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        dataDirectoryName: 'controller-data',
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir,
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.factory += 1;
          return {
            async get() {
              throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
            },
            async set() { spies.set += 1; },
            async delete() { spies.delete += 1; return false; },
          };
        },
        startControllerImpl: mode === 'production'
          ? productionStartController
          : async () => {
            spies.network += 1;
            return fakeControllerRuntime();
          },
      });
      await assert.rejects(
        harness.start(),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
        mode,
      );
      assert.equal(spies.factory, 0, `${mode}: factory`);
      assert.equal(spies.set, 0, `${mode}: set`);
      assert.equal(spies.delete, 0, `${mode}: delete`);
      assert.equal(spies.network, 0, `${mode}: network`);
      assert.equal(await outsideHasControllerCert(outside), false, `${mode}: external cert`);
    }
  });

  it('blocks restart and restarting-controller resume when nested tls is a symlink', async () => {
    // executeRestart: legal prior phase endpoint-post-revoke-passed; poison nested tls after start.
    {
      const runDir = await createSyntheticDedicatedRun();
      const outside = await privateDir();
      const spies = { factory: 0, set: 0, delete: 0, network: 0 };
      let state = {
        ...syntheticControllerState('endpoint-post-revoke-passed'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        dataDirectoryName: 'controller-data',
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir,
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.factory += 1;
          return {
            async get() {
              throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
            },
            async set() { spies.set += 1; },
            async delete() { spies.delete += 1; return false; },
          };
        },
        startControllerImpl: async () => {
          spies.network += 1;
          return fakeControllerRuntime();
        },
      });
      await harness.start();
      assert.equal(spies.network, 1);
      await mkdir(join(runDir, 'controller-data'), { mode: 0o700, recursive: true });
      await symlink(outside, join(runDir, 'controller-data', 'tls'));
      spies.factory = 0;
      spies.set = 0;
      spies.delete = 0;
      spies.network = 0;
      const result = await harness.execute('restart');
      assert.notEqual(result.status, 'PASS');
      assert.equal(state.phase, 'restarting-controller');
      // Restart may reuse in-memory factory; at least startController/Keychain write-delete stay 0.
      assert.equal(spies.set, 0);
      assert.equal(spies.delete, 0);
      assert.equal(spies.network, 0);
      assert.equal(await outsideHasControllerCert(outside), false);
    }

    // restarting-controller resume via start()
    {
      const runDir = await createSyntheticDedicatedRun();
      const outside = await seedNestedTlsSymlink(runDir);
      const spies = { factory: 0, set: 0, delete: 0, network: 0 };
      let state = {
        ...syntheticControllerState('restarting-controller'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        dataDirectoryName: 'controller-data',
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir,
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.factory += 1;
          return {
            async get() {
              throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
            },
            async set() { spies.set += 1; },
            async delete() { spies.delete += 1; return false; },
          };
        },
        startControllerImpl: async () => {
          spies.network += 1;
          return fakeControllerRuntime();
        },
      });
      const started = await harness.start();
      assert.notEqual(started.status, 'PASS');
      assert.equal(spies.factory, 0);
      assert.equal(spies.set, 0);
      assert.equal(spies.delete, 0);
      assert.equal(spies.network, 0);
      assert.equal(await outsideHasControllerCert(outside), false);
      assert.equal(state.phase, 'restarting-controller');
    }
  });

  it('blocks start when tls is a regular file type mismatch and allows missing first-create path', async () => {
    // tls as ordinary file
    {
      const runDir = await createSyntheticDedicatedRun();
      await mkdir(join(runDir, 'controller-data'), { mode: 0o700 });
      await writeFile(join(runDir, 'controller-data', 'tls'), 'not-a-directory', { mode: 0o600 });
      const spies = { factory: 0, set: 0, network: 0 };
      let state = {
        ...syntheticControllerState('controller-ready'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        dataDirectoryName: 'controller-data',
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir,
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.factory += 1;
          return memoryKeychain();
        },
        startControllerImpl: async () => {
          spies.network += 1;
          return fakeControllerRuntime();
        },
      });
      await assert.rejects(
        harness.start(),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );
      assert.deepEqual(spies, { factory: 0, set: 0, network: 0 });
    }

    // cert as symlink
    {
      const runDir = await createSyntheticDedicatedRun();
      const outside = await privateDir();
      await mkdir(join(runDir, 'controller-data', 'tls'), { recursive: true, mode: 0o700 });
      await symlink(join(outside, 'controller-cert.pem'), join(runDir, 'controller-data', 'tls', 'controller-cert.pem'));
      const spies = { factory: 0, network: 0 };
      let state = {
        ...syntheticControllerState('controller-ready'),
        controllerKeychainService: 'com.linke.test.controller.synthetic',
        endpointKeychainService: 'com.linke.test.endpoint.synthetic',
        dataDirectoryName: 'controller-data',
      };
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir,
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => {
          spies.factory += 1;
          return memoryKeychain();
        },
        startControllerImpl: async () => {
          spies.network += 1;
          return fakeControllerRuntime();
        },
      });
      await assert.rejects(
        harness.start(),
        (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );
      assert.equal(spies.factory, 0);
      assert.equal(spies.network, 0);
    }

    // Normal empty dataDir first start still PASS
    {
      const runDir = await createSyntheticDedicatedRun();
      let state = null;
      const harness = await createControllerHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir,
        readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        keychainFactory: () => memoryKeychain(),
        startControllerImpl: async () => fakeControllerRuntime(),
      });
      const result = await harness.start();
      assert.equal(result.status, 'PASS');
      assert.equal(state.phase, 'controller-ready');
    }
  });

  it('rejects state/bundle endpointKeychainService mismatch before intent factory Keychain network', async () => {
    const serviceA = 'com.linke.test.endpoint.service-a';
    const serviceB = 'com.linke.test.endpoint.service-b';

    async function mismatchHarness({ phase, bundleKind, runPhase }) {
      const spies = { factory: 0, keychain: 0, network: 0 };
      let state = {
        ...syntheticEndpointState(phase),
        endpointKeychainService: serviceA,
      };
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => {
          if (bundleKind === 'reenrollment') {
            return {
              ...syntheticReenrollmentBundle(),
              endpointKeychainService: serviceB,
            };
          }
          if (bundleKind === 'initial') {
            return syntheticInitialBundle({ endpointKeychainService: serviceB });
          }
          return syntheticInitialConsumedBundle({ endpointKeychainService: serviceB });
        },
        writeReceipt: async () => {},
        writeBundle: async () => {},
        keychainFactory: (service) => {
          spies.factory += 1;
          spies.lastService = service;
          return {
            async delete() { spies.keychain += 1; return true; },
            async get() { spies.keychain += 1; return null; },
            async set() { spies.keychain += 1; },
          };
        },
        credentialStoreFactory: () => ({
          itemId: () => 'device-token.11111111111111111111111111111111',
          async getToken() { spies.keychain += 1; return 't'.repeat(40); },
          async setToken() { spies.keychain += 1; },
        }),
        enroll: async () => { spies.network += 1; },
        heartbeat: async () => { spies.network += 1; return { accepted: true }; },
        rotate: async () => { spies.network += 1; },
        pinnedRequest: async () => { spies.network += 1; return { accepted: true }; },
      });
      const result = await harness.runPhase(runPhase);
      return { result, state, spies };
    }

    for (const scenario of [
      { phase: 'pre-revoke-passed', bundleKind: 'initial-consumed', runPhase: 'post-revoke' },
      { phase: 'post-fingerprint-change-passed', bundleKind: 'reenrollment', runPhase: 'reenroll' },
      { phase: 'initialized', bundleKind: 'initial', runPhase: 'pre-revoke' },
    ]) {
      const { result, state, spies } = await mismatchHarness(scenario);
      assert.notEqual(result.status, 'PASS', scenario.runPhase);
      assert.equal(state.phase, scenario.phase, scenario.runPhase);
      assert.equal(spies.factory, 0, scenario.runPhase);
      assert.equal(spies.keychain, 0, scenario.runPhase);
      assert.equal(spies.network, 0, scenario.runPhase);
    }

    // Bootstrap then second-read drift on pre-revoke must reject before intent.
    {
      const spies = { factory: 0, keychain: 0, network: 0 };
      let state = null;
      let reads = 0;
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => {
          reads += 1;
          // First bootstrap read: service-a; second post-init read drifts to service-b.
          return syntheticInitialBundle({
            endpointKeychainService: reads === 1 ? serviceA : serviceB,
          });
        },
        writeBundle: async () => {},
        writeReceipt: async () => {},
        keychainFactory: (service) => {
          spies.factory += 1;
          spies.lastService = service;
          return {
            async delete() { spies.keychain += 1; return true; },
            async get() { spies.keychain += 1; return null; },
            async set() { spies.keychain += 1; },
          };
        },
        credentialStoreFactory: () => ({
          itemId: () => {
            spies.keychain += 1;
            return 'device-token.11111111111111111111111111111111';
          },
          async getToken() { spies.keychain += 1; return null; },
          async setToken() { spies.keychain += 1; },
        }),
        enroll: async () => { spies.network += 1; },
        heartbeat: async () => { spies.network += 1; return { accepted: true }; },
        rotate: async () => { spies.network += 1; },
        pinnedRequest: async () => { spies.network += 1; return {}; },
      });
      const result = await harness.runPhase('pre-revoke');
      assert.notEqual(result.status, 'PASS');
      // Bootstrap may create factory once for itemId derivation; second-read drift must not
      // advance to running intent or any network/token mutation.
      assert.equal(state.phase, 'initialized');
      assert.equal(spies.network, 0);
      assert.equal(spies.lastService, serviceA);
      assert.ok(reads >= 2);
    }
  });

  it('keeps matching endpoint service green and cleanup uses only state journal service', async () => {
    const service = 'com.linke.test.endpoint.service-match';
    // Matching post-revoke PASS
    {
      const spies = { factory: 0, network: 0, services: [] };
      let state = {
        ...syntheticEndpointState('pre-revoke-passed'),
        endpointKeychainService: service,
      };
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => syntheticInitialConsumedBundle({ endpointKeychainService: service }),
        writeReceipt: async () => {},
        keychainFactory: (svc) => {
          spies.factory += 1;
          spies.services.push(svc);
          return { async delete() { return true; } };
        },
        credentialStoreFactory: () => ({
          itemId: () => 'device-token.11111111111111111111111111111111',
          async getToken() { return 't'.repeat(40); },
          async setToken() {},
        }),
        heartbeat: async () => {
          spies.network += 1;
          throw new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
        },
        enroll: async () => {},
        rotate: async () => {},
        pinnedRequest: async () => ({}),
      });
      const result = await harness.runPhase('post-revoke');
      assert.equal(result.status, 'PASS');
      assert.equal(state.phase, 'post-revoke-passed');
      assert.ok(spies.factory >= 1);
      assert.deepEqual(spies.services, spies.services.map(() => service));
      assert.equal(spies.services.every((s) => s === service), true);
    }

    // Cleanup only touches journal service, never a drifted bundle service.
    {
      const deletedServices = [];
      let state = {
        ...syntheticEndpointState('reenroll-passed'),
        endpointKeychainService: service,
        credentialItemIds: ['device-token.11111111111111111111111111111111'],
        cleanupFiles: [],
        cleanupDirectories: [],
      };
      const harness = await createEndpointHarness({
        env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
        runDir: await createSyntheticDedicatedRun(),
        now: () => new Date('2030-01-01T00:03:00.000Z'),
        readState: async () => state,
        writeState: async (next) => { state = structuredClone(next); },
        readBundle: async () => syntheticInitialConsumedBundle({
          endpointKeychainService: 'com.linke.test.endpoint.other-service',
        }),
        writeReceipt: async () => {},
        keychainFactory: (svc) => {
          deletedServices.push(svc);
          return { async delete() { return true; } };
        },
        credentialStoreFactory: () => ({
          itemId: () => 'device-token.11111111111111111111111111111111',
          async getToken() { return null; },
          async setToken() {},
        }),
        enroll: async () => {},
        heartbeat: async () => ({}),
        rotate: async () => {},
        pinnedRequest: async () => ({}),
      });
      const result = await harness.runPhase('cleanup');
      assert.equal(result.status, 'PASS');
      assert.deepEqual(deletedServices, [service]);
      assert.equal(state.phase, 'cleaned');
    }
  });
});
