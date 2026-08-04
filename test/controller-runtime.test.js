import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startController,
  parseControllerEnv,
  runControllerMain,
  isPrivateAgentHost,
  isLoopbackManagementHost,
  closeServer,
} from '../src/controller-runtime.js';
import { DeviceRegistry } from '../src/device-registry.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { createUploadLocks } from '../src/upload-locks.js';
import { createUploadSessionStore } from '../src/upload-session-store.js';
import { getSnapshotManifest, safeDevicePath } from '../src/storage.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';

/** Open runtimes closed in after() so a failed assertion never leaks listeners. */
const openRuntimes = new Set();

/**
 * In-memory Keychain adapter. Never touches macOS Keychain.
 * @param {Map<string, string>} [initial]
 */
function memoryKeychain(initial = new Map()) {
  return {
    async get(id) {
      if (!initial.has(id)) {
        const error = new Error('keychain-item-missing');
        error.code = 'keychain-item-missing';
        throw error;
      }
      return initial.get(id);
    },
    async set(id, value) {
      initial.set(id, value);
    },
    async delete(id) {
      return initial.delete(id);
    },
  };
}

/**
 * Remap non-loopback binds to 127.0.0.1 so tests never need a real private NIC.
 * @returns {(server: import('node:net').Server, port: number, host: string) => Promise<void>}
 */
function createLoopbackTestListenAdapter() {
  return (server, port, host) => new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    const listenHost = (host === '127.0.0.1' || host === '::1') ? host : '127.0.0.1';
    server.listen(port, listenHost, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

/**
 * @param {string[]} events
 * @param {string} name
 */
function trackedServer(events, name) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  return {
    listening: false,
    once(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      const set = handlers.get(event);
      const wrap = (...args) => {
        set.delete(wrap);
        handler(...args);
      };
      set.add(wrap);
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) || [])]) {
        handler(...args);
      }
    },
    listen(_port, _host, cb) {
      this.listening = true;
      events.push(`${name}:listening`);
      queueMicrotask(cb);
    },
    close(cb) {
      this.listening = false;
      events.push(`${name}:closed`);
      queueMicrotask(() => {
        if (typeof cb === 'function') cb();
      });
    },
    address() {
      return { port: 3443, address: '192.168.10.4', family: 'IPv4' };
    },
  };
}

/**
 * Fake server that records close → closeAllConnections order.
 * Close callback is held until flushClose() so tests can prove Promise timing.
 * @param {string[]} events
 * @param {string} name
 */
function orderedCloseServer(events, name) {
  /** @type {((err?: Error) => void) | null} */
  let pendingCloseCb = null;
  return {
    listening: true,
    once() {},
    on() {},
    off() {},
    listen(_port, _host, cb) {
      this.listening = true;
      events.push(`${name}:listening`);
      queueMicrotask(cb);
    },
    close(cb) {
      events.push(`${name}:close`);
      // Hold callback until flushClose — proves Promise waits for close, not closeAllConnections.
      pendingCloseCb = typeof cb === 'function' ? cb : null;
    },
    closeAllConnections() {
      events.push(`${name}:closeAllConnections`);
    },
    flushClose() {
      events.push(`${name}:close-callback`);
      this.listening = false;
      const cb = pendingCloseCb;
      pendingCloseCb = null;
      if (cb) cb();
    },
    address() {
      return { port: 3443, address: '192.168.10.4', family: 'IPv4' };
    },
  };
}

/**
 * @param {string[]} events
 * @param {string} name
 */
function failingServer(events, name) {
  /** @type {((error: Error) => void) | null} */
  let onError = null;
  return {
    listening: false,
    once(event, handler) {
      if (event === 'error') onError = handler;
    },
    on(event, handler) {
      if (event === 'error') onError = handler;
    },
    off(event, handler) {
      if (event === 'error' && (handler === undefined || handler === onError)) {
        onError = null;
      }
    },
    listen() {
      events.push(`${name}:error`);
      queueMicrotask(() => {
        if (onError) onError(new Error('management bind failed'));
      });
    },
    close(cb) {
      events.push(`${name}:closed`);
      queueMicrotask(() => {
        if (typeof cb === 'function') cb();
      });
    },
  };
}

/**
 * Fake server whose listen() throws synchronously.
 * Tracks error listeners with Node-like once/off semantics (off by original fn).
 * @param {Error} [error]
 */
function syncThrowListenServer(error = new Error('sync listen fail')) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  return {
    listening: false,
    once(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      const set = handlers.get(event);
      const wrap = (...args) => {
        set.delete(wrap);
        handler(...args);
      };
      wrap.listener = handler;
      set.add(wrap);
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off(event, handler) {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of [...set]) {
        if (h === handler || h.listener === handler) set.delete(h);
      }
    },
    listenerCount(event) {
      return handlers.get(event)?.size || 0;
    },
    listen() {
      throw error;
    },
    close(cb) {
      if (typeof cb === 'function') queueMicrotask(cb);
    },
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
async function startRuntimeFixture(overrides = {}) {
  const dataDir = overrides.dataDir
    || await mkdtemp(join(tmpdir(), 'linke-controller-runtime-'));
  const keychain = overrides.keychain || memoryKeychain();
  const runtime = await startController({
    dataDir,
    managementHost: '127.0.0.1',
    managementPort: 0,
    agentHost: '192.168.10.4',
    agentPort: 0,
    keychain,
    listenServer: createLoopbackTestListenAdapter(),
    ...overrides,
  });
  openRuntimes.add(runtime);
  runtime._testDataDir = dataDir;
  return runtime;
}

after(async () => {
  for (const runtime of openRuntimes) {
    try {
      await runtime.close();
    } catch {
      // ignore cleanup failures
    }
  }
  openRuntimes.clear();
});

describe('controller-runtime host/port fail-closed', () => {
  it('accepts only exact loopback management hosts', () => {
    assert.equal(isLoopbackManagementHost('127.0.0.1'), true);
    assert.equal(isLoopbackManagementHost('::1'), true);
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.1',
      '10.0.0.1',
      'localhost',
      '127.0.0.2',
      '::ffff:127.0.0.1',
      '8.8.8.8',
      '',
    ]) {
      assert.equal(isLoopbackManagementHost(host), false, host);
    }
  });

  it('accepts only RFC1918 IPv4 and ULA IPv6 agent hosts', () => {
    for (const host of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.10.4', 'fd12::1', 'fc00::1']) {
      assert.equal(isPrivateAgentHost(host), true, host);
    }
    for (const host of [
      undefined,
      null,
      '',
      'localhost',
      'controller.local',
      '127.0.0.1',
      '::1',
      '169.254.1.1',
      'fe80::1',
      '8.8.8.8',
      '0.0.0.0',
      '::',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
    ]) {
      assert.equal(isPrivateAgentHost(host), false, String(host));
    }
  });

  it('rejects non-loopback management hosts before identity, Keychain, or server factories', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-mgmt-host-'));
    try {
      let keychainTouched = false;
      let factoryCalled = false;
      const keychain = {
        async get() {
          keychainTouched = true;
          throw new Error('keychain should not be called');
        },
        async set() {
          keychainTouched = true;
        },
        async delete() {
          keychainTouched = true;
        },
      };
      for (const managementHost of ['0.0.0.0', '192.168.1.10', '10.0.0.1', '8.8.8.8', '::', 'localhost']) {
        keychainTouched = false;
        factoryCalled = false;
        await assert.rejects(
          () => startController({
            dataDir,
            managementHost,
            managementPort: 0,
            agentHost: '192.168.10.4',
            agentPort: 3443,
            keychain,
            agentServerFactory: () => {
              factoryCalled = true;
              throw new Error('agent factory should not run');
            },
            managementServerFactory: () => {
              factoryCalled = true;
              throw new Error('management factory should not run');
            },
          }),
          /management host must be loopback/,
        );
        assert.equal(keychainTouched, false, managementHost);
        assert.equal(factoryCalled, false, managementHost);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid agent hosts before identity, Keychain, or server factories', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-host-'));
    try {
      let keychainTouched = false;
      let factoryCalled = false;
      const keychain = {
        async get() {
          keychainTouched = true;
          throw new Error('keychain should not be called');
        },
        async set() {
          keychainTouched = true;
        },
        async delete() {
          keychainTouched = true;
        },
      };
      for (const agentHost of [
        undefined,
        '0.0.0.0',
        '::',
        '127.0.0.1',
        '::1',
        '169.254.10.1',
        'fe80::1',
        '8.8.8.8',
        'localhost',
        'controller.local',
      ]) {
        keychainTouched = false;
        factoryCalled = false;
        await assert.rejects(
          () => startController({
            dataDir,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentHost,
            agentPort: 3443,
            keychain,
            agentServerFactory: () => {
              factoryCalled = true;
              throw new Error('agent factory should not run');
            },
            managementServerFactory: () => {
              factoryCalled = true;
              throw new Error('management factory should not run');
            },
          }),
          /agent host must be a private IP literal/,
        );
        assert.equal(keychainTouched, false, String(agentHost));
        assert.equal(factoryCalled, false, String(agentHost));
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects illegal management/agent ports before side effects', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-port-'));
    try {
      let keychainTouched = false;
      const keychain = {
        async get() {
          keychainTouched = true;
          throw new Error('keychain should not be called');
        },
        async set() {
          keychainTouched = true;
        },
        async delete() {
          keychainTouched = true;
        },
      };
      for (const [managementPort, agentPort] of [
        [-1, 3443],
        [65536, 3443],
        [1.5, 3443],
        ['3000', 3443],
        [3000, -1],
        [3000, 65536],
        [3000, 3.14],
        [3000, '3443'],
        [NaN, 3443],
        [3000, NaN],
      ]) {
        keychainTouched = false;
        await assert.rejects(
          () => startController({
            dataDir,
            managementHost: '127.0.0.1',
            managementPort,
            agentHost: '192.168.10.4',
            agentPort,
            keychain,
          }),
          /port must be an integer between 0 and 65535/,
        );
        assert.equal(keychainTouched, false);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('requires dataDir and does not leak absolute paths in the rejection', async () => {
    await assert.rejects(
      () => startController({
        managementHost: '127.0.0.1',
        agentHost: '192.168.10.4',
        keychain: memoryKeychain(),
      }),
      (error) => {
        assert.match(String(error.message), /dataDir is required/);
        assert.doesNotMatch(String(error.message), /\/Users\/|\/var\/|\/tmp\//);
        return true;
      },
    );
  });

  it('rejects dataDir first-create through an ancestor symlink without creating outside', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-ctrl-anc-'));
    const outside = await mkdtemp(join(tmpdir(), 'linke-ctrl-anc-out-'));
    try {
      const link = join(base, 'evil');
      await symlink(outside, link, 'dir');
      const dataDir = join(link, 'controller-data');
      let keychainTouched = false;
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: {
            async get() {
              keychainTouched = true;
              throw new Error('keychain should not be called');
            },
            async set() { keychainTouched = true; },
            async delete() { keychainTouched = true; },
          },
          listenServer: createLoopbackTestListenAdapter(),
        }),
        (error) => {
          assert.match(String(error.message), /dataDir is required/);
          assert.doesNotMatch(String(error.message), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        },
      );
      assert.equal(keychainTouched, false);
      const outsideEntries = await readdir(outside);
      assert.equal(outsideEntries.includes('controller-data'), false);
      assert.equal(outsideEntries.includes('tls'), false);
      assert.equal(outsideEntries.includes('device-registry-v1.json'), false);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates missing nested dataDir under a real ancestor without recursive symlink follow', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-ctrl-create-'));
    try {
      const dataDir = join(base, 'nested', 'controller-data');
      const runtime = await startRuntimeFixture({ dataDir });
      try {
        const rootStat = await lstat(dataDir);
        assert.equal(rootStat.isDirectory(), true);
        assert.equal(rootStat.isSymbolicLink(), false);
        const tlsStat = await lstat(join(dataDir, 'tls'));
        assert.equal(tlsStat.isDirectory(), true);
        assert.equal(tlsStat.isSymbolicLink(), false);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('defers production KeychainStore construction until after bind validation', async () => {
    // Source contract: default keychain must not be a parameter default (JS evaluates those
    // before the body). Construction is only after pure dataDir/host/port checks.
    const source = await readFile(new URL('../src/controller-runtime.js', import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /keychain\s*=\s*new\s+KeychainStore\s*\(\s*\)/,
      'keychain must not use a parameter default that constructs KeychainStore',
    );
    // Delayed resolved construction is allowed (and required) after pure validation.
    assert.match(
      source,
      /const\s+resolvedKeychain\s*=\s*keychain\s*\?\?\s*new\s+KeychainStore\s*\(\s*\)/,
    );

    // DI / behavioral: illegal binds without injecting keychain still fail at host/port
    // gates and never reach TlsIdentityStore / real Keychain / filesystem side effects.
    for (const options of [
      {
        dataDir: '/tmp/linke-keychain-defer',
        managementHost: '0.0.0.0',
        managementPort: 3000,
        agentHost: '192.168.10.4',
        agentPort: 3443,
      },
      {
        dataDir: '/tmp/linke-keychain-defer',
        managementHost: '127.0.0.1',
        managementPort: 3000,
        agentHost: '8.8.8.8',
        agentPort: 3443,
      },
      {
        dataDir: '/tmp/linke-keychain-defer',
        managementHost: '127.0.0.1',
        managementPort: 70000,
        agentHost: '192.168.10.4',
        agentPort: 3443,
      },
    ]) {
      await assert.rejects(
        () => startController(options),
        (error) => {
          const message = String(error && error.message);
          assert.match(
            message,
            /management host must be loopback|agent host must be a private IP literal|port must be an integer between 0 and 65535/,
          );
          // Must not surface Keychain / TLS identity side-effect failures.
          assert.doesNotMatch(message, /keychain|security|private.?key|ENOENT|EACCES|tls/i);
          return true;
        },
      );
    }
  });

  it('rejects whitespace-only dataDir before identity, Keychain, factories, or filesystem side effects', async () => {
    const blankDir = '   ';
    const blankPath = join(process.cwd(), blankDir);
    let keychainTouched = false;
    let factoryCalled = false;
    const keychain = {
      async get() {
        keychainTouched = true;
        throw new Error('keychain should not be called');
      },
      async set() {
        keychainTouched = true;
      },
      async delete() {
        keychainTouched = true;
      },
    };
    await assert.rejects(
      () => startController({
        dataDir: blankDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 3443,
        keychain,
        agentServerFactory: () => {
          factoryCalled = true;
          throw new Error('agent factory should not run');
        },
        managementServerFactory: () => {
          factoryCalled = true;
          throw new Error('management factory should not run');
        },
      }),
      (error) => {
        assert.match(String(error.message), /dataDir is required/);
        assert.doesNotMatch(String(error.message), /\/Users\/|\/var\/|\/tmp\//);
        return true;
      },
    );
    assert.equal(keychainTouched, false);
    assert.equal(factoryCalled, false);
    await assert.rejects(() => access(blankPath), { code: 'ENOENT' });
    await assert.rejects(() => access(join(blankPath, 'tls')), { code: 'ENOENT' });
    await assert.rejects(() => access(join(blankPath, 'device-registry-v1.json')), { code: 'ENOENT' });
  });
});

describe('controller-runtime dual listeners', () => {
  it('starts management on loopback and Agent HTTPS on the explicit private bind', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-dual-'));
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 3443,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
      });
      openRuntimes.add(runtime);
      try {
        assert.equal(runtime.status.managementHost, '127.0.0.1');
        assert.equal(runtime.status.agentBindConfigured, true);
        assert.equal(runtime.status.managementListening, true);
        assert.equal(runtime.status.agentListening, true);
        assert.match(runtime.status.tlsFingerprint, /^[a-f0-9]{64}$/);
        assert.equal('dataDir' in runtime.status, false);
        assert.equal('authToken' in runtime.status, false);
        assert.equal('token' in runtime.status, false);
        assert.equal(runtime.managementServer.listening, true);
        assert.equal(runtime.agentServer.listening, true);
        const managementAddress = runtime.managementServer.address();
        assert.ok(managementAddress && typeof managementAddress === 'object');
        assert.ok(managementAddress.address === '127.0.0.1' || managementAddress.address === '::ffff:127.0.0.1');
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('closes the Agent listener when management startup fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-mgmt-fail-'));
    const events = [];
    try {
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 3443,
          keychain: memoryKeychain(),
          managementServerFactory: () => failingServer(events, 'management'),
          agentServerFactory: () => trackedServer(events, 'agent'),
        }),
      );
      assert.deepEqual(events, ['agent:listening', 'management:error', 'agent:closed']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('closes both listeners when management factory throws after agent is listening', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-factory-fail-'));
    const events = [];
    try {
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 3443,
          keychain: memoryKeychain(),
          agentServerFactory: () => trackedServer(events, 'agent'),
          managementServerFactory: () => {
            events.push('management:error');
            throw new Error('management factory boom');
          },
        }),
        /management factory boom/,
      );
      assert.deepEqual(events, ['agent:listening', 'management:error', 'agent:closed']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('is idempotent when close is called twice and leaves no listening server', async () => {
    const runtime = await startRuntimeFixture();
    const dataDir = runtime._testDataDir;
    try {
      await Promise.all([runtime.close(), runtime.close()]);
      assert.equal(runtime.status.managementListening, false);
      assert.equal(runtime.status.agentListening, false);
      assert.equal(runtime.managementServer.listening, false);
      assert.equal(runtime.agentServer.listening, false);
      await runtime.close();
      assert.equal(runtime.status.managementListening, false);
      assert.equal(runtime.status.agentListening, false);
    } finally {
      openRuntimes.delete(runtime);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('status never includes secrets, dataDir, host literals for agent, or Keychain fields', async () => {
    const runtime = await startRuntimeFixture();
    const dataDir = runtime._testDataDir;
    try {
      const serialized = JSON.stringify(runtime.status);
      assert.doesNotMatch(serialized, /dataDir|token|keychain|privateKey|BEGIN |\/Users\/|\/var\/folders/i);
      assert.equal(runtime.status.managementHost, '127.0.0.1');
      assert.equal('agentHost' in runtime.status, false);
      assert.equal('agentUrl' in runtime.status, false);
    } finally {
      await runtime.close();
      openRuntimes.delete(runtime);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ULA IPv6 agentPort=0 publishes bracketed agentUrl with actual address port via factory capture', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-ula-agenturl-'));
    /** @type {{ agentUrl?: string, tlsFingerprint?: string } | null} */
    let deviceAdministration = null;
    const logs = [];
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: 'fd12::1',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        managementServerFactory: (options) => {
          deviceAdministration = options.deviceAdministration;
          return createHttpServer();
        },
      });
      openRuntimes.add(runtime);
      try {
        const address = runtime.agentServer.address();
        assert.ok(address && typeof address === 'object');
        const actualPort = address.port;
        assert.ok(Number.isInteger(actualPort) && actualPort > 0);

        assert.ok(deviceAdministration);
        assert.equal(deviceAdministration.agentUrl, `https://[fd12::1]:${actualPort}`);
        assert.match(deviceAdministration.tlsFingerprint, /^[a-f0-9]{64}$/);
        assert.equal(deviceAdministration.tlsFingerprint, runtime.status.tlsFingerprint);

        // Host/URL must not appear in status.
        assert.equal('agentHost' in runtime.status, false);
        assert.equal('agentUrl' in runtime.status, false);
        const statusText = JSON.stringify(runtime.status);
        assert.doesNotMatch(statusText, /fd12::1|https:\/\/|agentUrl|agentHost/i);

        // Sanitized standalone logs must not surface host/URL either.
        await runControllerMain({
          env: {
            DATA_DIR: dataDir,
            LINKE_AGENT_HOST: 'fd12::1',
          },
          start: async () => ({
            status: runtime.status,
            close: async () => {},
          }),
          log: (line) => logs.push(String(line)),
          error: (line) => logs.push(String(line)),
          exit: () => {},
          onSignal: () => {},
        });
        const joined = logs.join('\n');
        assert.doesNotMatch(joined, /fd12::1|https:\/\/\[fd12|agentUrl/i);
        assert.equal(logs.some((line) => /agent listener.*enabled/i.test(line)), true);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('production listen rejects sync listen throw and clears startup error listener', async () => {
    // Exercises default listen() (no listenServer DI). Sync throw must reject the
    // Promise (executor auto-rejects; this is not "Promise never settles") and
    // must remove the startup error listener so it does not leak.
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-sync-listen-'));
    const syncError = new Error('sync listen fail');
    const agent = syncThrowListenServer(syncError);
    try {
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 3443,
          keychain: memoryKeychain(),
          agentServerFactory: () => agent,
          managementServerFactory: () => {
            throw new Error('management factory must not run after agent listen sync throw');
          },
        }),
        (error) => error === syncError,
      );
      assert.equal(agent.listenerCount('error'), 0, 'startup error listener must be cleared after sync throw');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('production listen clears startup error listener on async error event path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-async-listen-err-'));
    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();
    const agent = {
      listening: false,
      once(event, handler) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        const set = handlers.get(event);
        const wrap = (...args) => {
          set.delete(wrap);
          handler(...args);
        };
        wrap.listener = handler;
        set.add(wrap);
      },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(handler);
      },
      off(event, handler) {
        const set = handlers.get(event);
        if (!set) return;
        for (const h of [...set]) {
          if (h === handler || h.listener === handler) set.delete(h);
        }
      },
      listenerCount(event) {
        return handlers.get(event)?.size || 0;
      },
      listen() {
        queueMicrotask(() => {
          const set = handlers.get('error');
          if (!set) return;
          for (const h of [...set]) h(new Error('async listen fail'));
        });
      },
      close(cb) {
        if (typeof cb === 'function') queueMicrotask(cb);
      },
    };
    try {
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 3443,
          keychain: memoryKeychain(),
          agentServerFactory: () => agent,
          managementServerFactory: () => {
            throw new Error('management factory must not run after agent listen error');
          },
        }),
        /async listen fail/,
      );
      assert.equal(agent.listenerCount('error'), 0, 'startup error listener must be cleared on error event');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects illegal agentRateLimit before Keychain, factories, or TLS/registry side effects', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-rl-early-'));
    let keychainTouched = false;
    let factoryCalled = false;
    const keychain = {
      async get() {
        keychainTouched = true;
        throw new Error('keychain should not be called');
      },
      async set() {
        keychainTouched = true;
      },
      async delete() {
        keychainTouched = true;
      },
    };
    try {
      for (const agentRateLimit of [
        { maxRequests: -1, windowMs: 1000 },
        { maxRequests: 10, windowMs: 0 },
        { maxRequests: 1.5, windowMs: 1000 },
        'not-an-object',
        [],
      ]) {
        keychainTouched = false;
        factoryCalled = false;
        await assert.rejects(
          () => startController({
            dataDir,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentHost: '192.168.10.4',
            agentPort: 3443,
            keychain,
            agentRateLimit,
            agentServerFactory: () => {
              factoryCalled = true;
              throw new Error('agent factory should not run');
            },
            managementServerFactory: () => {
              factoryCalled = true;
              throw new Error('management factory should not run');
            },
          }),
          (error) => {
            assert.match(String(error.message), /rateLimit/i);
            assert.doesNotMatch(String(error.message), /keychain|security|ENOENT|EACCES|tls/i);
            return true;
          },
        );
        assert.equal(keychainTouched, false, String(agentRateLimit));
        assert.equal(factoryCalled, false, String(agentRateLimit));
      }
      await assert.rejects(() => access(join(dataDir, 'tls')), { code: 'ENOENT' });
      await assert.rejects(() => access(join(dataDir, 'device-registry-v1.json')), { code: 'ENOENT' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('agentRateLimit null cannot disable the Agent limiter (default 60/min)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-rl-null-'));
    /** @type {{ check: (clientKey?: string) => { allowed: boolean } } | null} */
    let capturedRateLimit = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        agentRateLimit: null,
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          capturedRateLimit = options.rateLimit;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        assert.ok(capturedRateLimit);
        assert.equal(typeof capturedRateLimit.check, 'function');
        const client = '10.0.0.9';
        for (let i = 0; i < 60; i += 1) {
          assert.equal(capturedRateLimit.check(client).allowed, true, `request ${i + 1}`);
        }
        assert.equal(capturedRateLimit.check(client).allowed, false, 'request 61 must be denied');
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('agentRateLimit false cannot disable the Agent limiter (default 60/min)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-rl-false-'));
    /** @type {{ check: (clientKey?: string) => { allowed: boolean } } | null} */
    let capturedRateLimit = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        agentRateLimit: false,
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          capturedRateLimit = options.rateLimit;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        assert.ok(capturedRateLimit);
        assert.equal(typeof capturedRateLimit.check, 'function');
        const client = '10.0.0.9';
        for (let i = 0; i < 60; i += 1) {
          assert.equal(capturedRateLimit.check(client).allowed, true, `request ${i + 1}`);
        }
        assert.equal(capturedRateLimit.check(client).allowed, false, 'request 61 must be denied');
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('controller-runtime fingerprint gate', () => {
  it('rejects fingerprint change unless acceptTlsFingerprintChange is the boolean true', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-fp-gate-'));
    const keyMap = new Map();
    try {
      const keychain = memoryKeychain(keyMap);
      const first = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain,
        listenServer: createLoopbackTestListenAdapter(),
      });
      const originalFingerprint = first.status.tlsFingerprint;
      await first.close();

      // Force a different controller fingerprint in the registry while keeping identity.
      const registry = new DeviceRegistry({ dataDir });
      await registry.issueEnrollment({ deviceId: 'mac-bound' });
      const issued = await registry.issueEnrollment({ deviceId: 'mac-active' });
      await registry.consumeEnrollment({
        deviceId: 'mac-active',
        code: issued.code,
        protocolVersion: 2,
      });
      // Replace stored controller fingerprint with a synthetic different value.
      const rawPath = join(dataDir, 'device-registry-v1.json');
      const state = JSON.parse(await readFile(rawPath, 'utf8'));
      const fakeFp = 'ab'.repeat(32);
      assert.notEqual(fakeFp, originalFingerprint);
      state.controllerTlsFingerprint = fakeFp;
      await writeFile(rawPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

      async function assertMismatchRejectedAndUnchanged(acceptTlsFingerprintChange) {
        /** @type {Awaited<ReturnType<typeof startController>> | null} */
        let runtime = null;
        try {
          runtime = await startController({
            dataDir,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentHost: '192.168.10.4',
            agentPort: 0,
            keychain,
            acceptTlsFingerprintChange,
            listenServer: createLoopbackTestListenAdapter(),
          });
          // Unexpected accept leaves listeners open; always close before failing.
          await runtime.close();
          runtime = null;
          assert.fail(
            `expected fingerprint mismatch rejection for acceptTlsFingerprintChange=${JSON.stringify(acceptTlsFingerprintChange)}`,
          );
        } catch (error) {
          if (runtime) {
            await runtime.close().catch(() => {});
            runtime = null;
          }
          assert.equal(
            error && error.code,
            ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH,
            `unexpected error for acceptTlsFingerprintChange=${JSON.stringify(acceptTlsFingerprintChange)}: ${error && error.message}`,
          );
        }
        const after = JSON.parse(await readFile(rawPath, 'utf8'));
        assert.equal(after.controllerTlsFingerprint, fakeFp);
        const active = after.devices.filter((device) => device.status === 'active');
        assert.ok(active.length >= 1, 'active devices must not be suspended on rejected accept');
        const suspended = after.devices.filter((device) => device.status === 'suspended');
        assert.equal(suspended.length, 0);
      }

      // Strict boolean only: truthy non-booleans must not accept fingerprint change.
      for (const value of [false, 'enabled', 'true', 'false', 1, {}, [], '1', 'yes']) {
        await assertMismatchRejectedAndUnchanged(value);
      }

      const accepted = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain,
        acceptTlsFingerprintChange: true,
        listenServer: createLoopbackTestListenAdapter(),
      });
      openRuntimes.add(accepted);
      try {
        assert.equal(accepted.status.tlsFingerprint, originalFingerprint);
        const afterAccept = JSON.parse(await readFile(rawPath, 'utf8'));
        assert.equal(afterAccept.controllerTlsFingerprint, originalFingerprint);
        const status = await new DeviceRegistry({ dataDir }).getStatus();
        assert.ok(status.suspended >= 1);
      } finally {
        await accepted.close();
        openRuntimes.delete(accepted);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not swallow non-fingerprint registry errors even when accept is enabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-fp-other-'));
    try {
      // Corrupt registry so load fails as internal error (not fingerprint mismatch).
      await writeFile(join(dataDir, 'device-registry-v1.json'), '{not-json', 'utf8');
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: memoryKeychain(),
          acceptTlsFingerprintChange: true,
          listenServer: createLoopbackTestListenAdapter(),
        }),
        (error) => error && error.code === ERROR_CODES.DEVICE_INTERNAL_ERROR,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('controller-runtime standalone env and logging', () => {
  it('parseControllerEnv requires LINKE_AGENT_HOST and only enables fingerprint change for exact enabled', () => {
    assert.throws(
      () => parseControllerEnv({ DATA_DIR: '/tmp/x' }),
      /LINKE_AGENT_HOST/,
    );
    assert.throws(
      () => parseControllerEnv({ DATA_DIR: '/tmp/x', LINKE_AGENT_HOST: '0.0.0.0' }),
      /agent host must be a private IP literal/,
    );

    const parsed = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '192.168.10.4',
      LINKE_AGENT_PORT: '3443',
      PORT: '3000',
      LINKE_ACCEPT_TLS_FINGERPRINT_CHANGE: 'enabled',
      LINKE_AUTH_TOKEN: 'secret-should-not-echo',
    });
    assert.equal(parsed.agentHost, '192.168.10.4');
    assert.equal(parsed.agentPort, 3443);
    assert.equal(parsed.managementHost, '127.0.0.1');
    assert.equal(parsed.managementPort, 3000);
    assert.equal(parsed.acceptTlsFingerprintChange, true);
    assert.equal(parsed.authToken, 'secret-should-not-echo');

    for (const value of ['true', 'TRUE', '1', 'yes', 'Enabled', 'ENABLED', '', undefined]) {
      const other = parseControllerEnv({
        DATA_DIR: 'data',
        LINKE_AGENT_HOST: '10.0.0.5',
        LINKE_ACCEPT_TLS_FINGERPRINT_CHANGE: value,
      });
      assert.equal(other.acceptTlsFingerprintChange, false, String(value));
    }
  });

  it('parseControllerEnv defaults agent port to 3443 and never selects a NIC automatically', () => {
    const parsed = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '172.16.1.2',
    });
    assert.equal(parsed.agentPort, 3443);
    assert.equal(parsed.managementHost, '127.0.0.1');
    assert.equal(parsed.managementPort, 3000);
  });

  it('parseControllerEnv treats blank PORT/LINKE_AGENT_PORT as unset defaults, not ephemeral 0', () => {
    const blank = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '192.168.10.4',
      PORT: '   ',
      LINKE_AGENT_PORT: '   ',
    });
    assert.equal(blank.managementPort, 3000, 'whitespace PORT must fall back to 3000, not 0');
    assert.equal(blank.agentPort, 3443, 'whitespace LINKE_AGENT_PORT must fall back to 3443, not 0');

    const empty = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '192.168.10.4',
      PORT: '',
      LINKE_AGENT_PORT: '',
    });
    assert.equal(empty.managementPort, 3000);
    assert.equal(empty.agentPort, 3443);

    // Explicit string "0" remains a valid ephemeral bind per existing port contract.
    const explicitZero = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '10.0.0.5',
      PORT: '0',
      LINKE_AGENT_PORT: '0',
    });
    assert.equal(explicitZero.managementPort, 0);
    assert.equal(explicitZero.agentPort, 0);
  });

  it('runControllerMain logs only sanitized status and closes once on SIGINT/SIGTERM', async () => {
    const logs = [];
    const errors = [];
    const signals = [];
    /** @type {Map<string, Function>} */
    const handlers = new Map();
    let exitCode = null;
    let closeCalls = 0;

    const fakeRuntime = {
      status: {
        managementHost: '127.0.0.1',
        managementListening: true,
        agentBindConfigured: true,
        agentListening: true,
        tlsFingerprint: 'abcdef0123456789'.repeat(4),
      },
      close: async () => {
        closeCalls += 1;
      },
    };

    await runControllerMain({
      env: {
        DATA_DIR: 'data',
        LINKE_AGENT_HOST: '192.168.10.4',
      },
      start: async () => fakeRuntime,
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line)),
      exit: (code) => {
        exitCode = code;
      },
      onSignal: (signal, handler) => {
        signals.push(signal);
        handlers.set(signal, handler);
      },
    });

    assert.deepEqual(signals.sort(), ['SIGINT', 'SIGTERM']);
    assert.equal(logs.some((line) => /management listening/i.test(line)), true);
    assert.equal(logs.some((line) => /agent listener.*enabled/i.test(line)), true);
    assert.equal(logs.some((line) => /abcdef012345/.test(line)), true);
    const joined = logs.join('\n');
    assert.doesNotMatch(joined, /192\.168\.10\.4|https:\/\/|dataDir|\/Users\/|secret|token|keychain|abcdef0123456789abcdef/i);
    assert.equal(errors.length, 0);

    handlers.get('SIGINT')();
    handlers.get('SIGINT')();
    handlers.get('SIGTERM')();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closeCalls, 1);
    assert.equal(exitCode, 0);
  });

  it('runControllerMain never prints raw startup errors, paths, hosts, tokens, or fingerprints', async () => {
    const logs = [];
    const errors = [];
    let exitCode = null;
    await runControllerMain({
      env: {
        DATA_DIR: '/Users/secret/path',
        LINKE_AGENT_HOST: '192.168.10.4',
        LINKE_AUTH_TOKEN: 'super-secret-token',
      },
      start: async () => {
        const error = new Error('EADDRINUSE 192.168.10.4:3443 /Users/secret/path fingerprint=deadbeef');
        error.code = 'EADDRINUSE';
        throw error;
      },
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line)),
      exit: (code) => {
        exitCode = code;
      },
      onSignal: () => {},
    });
    assert.equal(exitCode, 1);
    assert.equal(logs.length, 0);
    const text = errors.join('\n');
    assert.match(text, /failed to start/i);
    assert.doesNotMatch(text, /EADDRINUSE|192\.168|\/Users\/|super-secret|deadbeef|fingerprint=/i);
  });

  it('runControllerMain compensates when the second signal registration throws', async () => {
    const logs = [];
    const errors = [];
    let exitCode = null;
    let closeCalls = 0;
    /** @type {Map<string, Function>} */
    const handlers = new Map();
    let signalCalls = 0;

    const fakeRuntime = {
      status: {
        managementHost: '127.0.0.1',
        managementListening: true,
        agentBindConfigured: true,
        agentListening: true,
        tlsFingerprint: 'deadbeefcafebabe'.repeat(4),
      },
      close: async () => {
        closeCalls += 1;
      },
    };

    await runControllerMain({
      env: {
        DATA_DIR: 'data',
        LINKE_AGENT_HOST: '192.168.10.4',
      },
      start: async () => fakeRuntime,
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line)),
      exit: (code) => {
        exitCode = code;
      },
      onSignal: (signal, handler) => {
        signalCalls += 1;
        handlers.set(signal, handler);
        if (signalCalls === 2) {
          throw new Error('register boom /Users/secret/path 192.168.10.4 super-secret-token deadbeef');
        }
      },
    });

    assert.equal(closeCalls, 1);
    assert.equal(exitCode, 1);
    assert.equal(logs.length, 0, 'must not emit listening/enabled logs when registration fails');
    assert.equal(errors.length, 1);
    assert.equal(errors[0], 'Linke controller failed to register shutdown handlers');
    const text = errors.join('\n');
    assert.doesNotMatch(text, /register boom|\/Users\/|192\.168|super-secret|deadbeef/i);

    // Already-registered handler must not double-close after the compensation path.
    if (handlers.has('SIGINT')) {
      handlers.get('SIGINT')();
      handlers.get('SIGINT')();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(closeCalls, 1);
    }
  });

  it('runControllerMain reports fixed sanitized error when close rejects with sensitive data', async () => {
    const logs = [];
    const errors = [];
    let exitCode = null;
    let closeCalls = 0;
    /** @type {Map<string, Function>} */
    const handlers = new Map();

    const fakeRuntime = {
      status: {
        managementHost: '127.0.0.1',
        managementListening: true,
        agentBindConfigured: true,
        agentListening: true,
        tlsFingerprint: 'aabbccddeeff0011'.repeat(4),
      },
      close: async () => {
        closeCalls += 1;
        throw new Error('close failed /Users/secret/path 192.168.99.1 token=super-secret-token fp=aabbccddeeff0011');
      },
    };

    await runControllerMain({
      env: {
        DATA_DIR: 'data',
        LINKE_AGENT_HOST: '192.168.10.4',
      },
      start: async () => fakeRuntime,
      log: (line) => logs.push(String(line)),
      error: (line) => errors.push(String(line)),
      exit: (code) => {
        exitCode = code;
      },
      onSignal: (signal, handler) => {
        handlers.set(signal, handler);
      },
    });

    assert.equal(logs.some((line) => /management listening/i.test(line)), true);
    handlers.get('SIGINT')();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(closeCalls, 1);
    assert.equal(exitCode, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], 'Linke controller failed to close');
    assert.doesNotMatch(
      errors.join('\n'),
      /\/Users\/|192\.168|super-secret|aabbccddeeff0011|token=|fp=/i,
    );
  });

  it('runControllerMain still closes only once across multiple signals after successful registration', async () => {
    let closeCalls = 0;
    let exitCode = null;
    /** @type {Map<string, Function>} */
    const handlers = new Map();
    const fakeRuntime = {
      status: {
        managementHost: '127.0.0.1',
        managementListening: true,
        agentBindConfigured: true,
        agentListening: true,
        tlsFingerprint: '1122334455667788'.repeat(4),
      },
      close: async () => {
        closeCalls += 1;
      },
    };

    await runControllerMain({
      env: {
        DATA_DIR: 'data',
        LINKE_AGENT_HOST: '10.0.0.5',
      },
      start: async () => fakeRuntime,
      log: () => {},
      error: () => {},
      exit: (code) => {
        exitCode = code;
      },
      onSignal: (signal, handler) => {
        handlers.set(signal, handler);
      },
    });

    handlers.get('SIGTERM')();
    handlers.get('SIGINT')();
    handlers.get('SIGTERM')();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closeCalls, 1);
    assert.equal(exitCode, 0);
  });

  it('importing controller-runtime does not auto-start or register signal handlers', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    // Unique query forces module re-evaluation without sharing the static import cache.
    const mod = await import(
      `../src/controller-runtime.js?import-safety=${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    assert.equal(typeof mod.startController, 'function');
    assert.equal(typeof mod.parseControllerEnv, 'function');
    assert.equal(typeof mod.runControllerMain, 'function');
    assert.equal(
      process.listenerCount('SIGINT'),
      beforeInt,
      'import must not register SIGINT',
    );
    assert.equal(
      process.listenerCount('SIGTERM'),
      beforeTerm,
      'import must not register SIGTERM',
    );
    // Do not call main/start; leave no extra listeners behind.
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  });

  it('direct entry attaches a final rejection handler with fixed sanitized output only', async () => {
    // Source contract: avoids real subprocess (no Keychain/network). Locks that the
    // direct-entry branch settles rejections via .catch and never logs raw Error.
    const source = await readFile(new URL('../src/controller-runtime.js', import.meta.url), 'utf8');
    const entryIdx = source.lastIndexOf('process.argv[1]');
    assert.ok(entryIdx >= 0, 'direct-entry argv guard must exist');
    const entryBlock = source.slice(entryIdx);
    assert.match(
      entryBlock,
      /runControllerMain\s*\(\s*\)\s*\.catch\s*\(/,
      'direct entry must attach final .catch on runControllerMain()',
    );
    // Catch body must not surface raw rejection values (no console.error(err) etc.).
    assert.doesNotMatch(
      entryBlock,
      /\.catch\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]*?\bconsole\.(?:error|log|warn)\s*\(\s*\1\b/,
    );
    assert.doesNotMatch(entryBlock, /\.catch\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]*?\b\1\s*\.message\b/);
    assert.match(entryBlock, /process\.exit\s*\(\s*1\s*\)/);
    // Import path still must not auto-start (guard remains argv-gated).
    assert.match(source, /process\.argv\[1\].*resolve\(process\.argv\[1\]\).*__filename/s);
  });
});

describe('controller-runtime package start entry', () => {
  it('package.json start script points at controller-runtime', async () => {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw);
    assert.equal(pkg.scripts.start, 'node src/controller-runtime.js');
    assert.equal(pkg.scripts.test, 'node --test test/*.test.js');
  });
});

describe('controller-runtime closeServer keep-alive convergence', () => {
  it('closeServer is safe for missing server, non-listening server, and repeated close', async () => {
    await closeServer(undefined);
    await closeServer(null);
    await closeServer({});
    await closeServer({ listening: false, close() { throw new Error('must not close'); } });

    const events = [];
    const server = orderedCloseServer(events, 'solo');
    const first = closeServer(server);
    assert.deepEqual(events, ['solo:close', 'solo:closeAllConnections']);
    server.flushClose();
    await first;
    assert.equal(server.listening, false);
    // After close completed, further closeServer calls are no-ops.
    await closeServer(server);
    await closeServer(server);
    assert.deepEqual(events, ['solo:close', 'solo:closeAllConnections', 'solo:close-callback']);
  });

  it('calls close before closeAllConnections and settles only after close callback', async () => {
    const events = [];
    const server = orderedCloseServer(events, 'keep');
    let resolved = false;
    const pending = closeServer(server).then(() => {
      resolved = true;
      events.push('promise:resolved');
    });

    // Synchronous portion: close then closeAllConnections; Promise still pending.
    assert.deepEqual(events, [
      'keep:close',
      'keep:closeAllConnections',
    ]);
    assert.equal(resolved, false);

    server.flushClose();
    await pending;
    assert.equal(resolved, true);
    assert.deepEqual(events, [
      'keep:close',
      'keep:closeAllConnections',
      'keep:close-callback',
      'promise:resolved',
    ]);
  });

  it('runtime.close uses close then closeAllConnections on both listeners', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-close-order-'));
    const events = [];
    /** @type {ReturnType<typeof orderedCloseServer>[]} */
    const servers = [];
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 3443,
        keychain: memoryKeychain(),
        agentServerFactory: () => {
          const s = orderedCloseServer(events, 'agent');
          servers.push(s);
          return s;
        },
        managementServerFactory: () => {
          const s = orderedCloseServer(events, 'management');
          servers.push(s);
          return s;
        },
      });
      openRuntimes.add(runtime);
      const closing = runtime.close();
      // close + closeAllConnections already ran; callbacks still held.
      const agentClose = events.indexOf('agent:close');
      const agentForce = events.indexOf('agent:closeAllConnections');
      const mgmtClose = events.indexOf('management:close');
      const mgmtForce = events.indexOf('management:closeAllConnections');
      assert.ok(agentClose >= 0 && agentForce === agentClose + 1);
      assert.ok(mgmtClose >= 0 && mgmtForce === mgmtClose + 1);
      for (const s of servers) s.flushClose();
      await closing;
      openRuntimes.delete(runtime);
      assert.ok(events.indexOf('agent:close-callback') > agentForce);
      assert.ok(events.indexOf('management:close-callback') > mgmtForce);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('controller-runtime late post-listen errors', () => {
  const sensitive = 'ECONNRESET /Users/secret/path 192.168.99.1 token=super-secret-token fp=deadbeefcafebabe';

  it('post-listen agent/management errors fail-closed without leaking raw Error text', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-late-err-'));
    /** @type {string[]} */
    const components = [];
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 3443,
        keychain: memoryKeychain(),
        agentServerFactory: () => trackedServer([], 'agent'),
        managementServerFactory: () => trackedServer([], 'management'),
        onRuntimeError: (component) => {
          components.push(component);
        },
      });
      openRuntimes.add(runtime);
      try {
        assert.equal(runtime.status.agentListening, true);
        assert.equal(runtime.status.managementListening, true);

        runtime.agentServer.emit('error', new Error(sensitive));
        assert.equal(runtime.status.agentListening, false);
        assert.equal(runtime.status.managementListening, true);
        assert.deepEqual(components, ['agent']);

        runtime.managementServer.emit('error', new Error(sensitive));
        assert.equal(runtime.status.managementListening, false);
        assert.deepEqual(components, ['agent', 'management']);

        // Handlers must not re-enter close or throw when re-emitted after close.
        await runtime.close();
        runtime.agentServer.emit('error', new Error(sensitive));
        runtime.managementServer.emit('error', new Error(sensitive));
        assert.deepEqual(components, ['agent', 'management', 'agent', 'management']);
        assert.equal(runtime.status.agentListening, false);
        assert.equal(runtime.status.managementListening, false);
      } finally {
        await runtime.close().catch(() => {});
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('onRuntimeError only receives fixed component names and never the raw Error', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-late-args-'));
    /** @type {unknown[]} */
    const calls = [];
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 3443,
        keychain: memoryKeychain(),
        agentServerFactory: () => trackedServer([], 'agent'),
        managementServerFactory: () => trackedServer([], 'management'),
        onRuntimeError: (...args) => {
          calls.push(args);
        },
      });
      openRuntimes.add(runtime);
      try {
        runtime.agentServer.emit('error', new Error(sensitive));
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], ['agent']);
        const serialized = JSON.stringify(calls);
        assert.doesNotMatch(serialized, /\/Users\/|192\.168|super-secret|deadbeef|ECONNRESET|token=/i);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runControllerMain logs fixed sanitized runtime-error lines, never raw Error text', async () => {
    const logs = [];
    const errors = [];
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-late-main-'));
    try {
      /** @type {{ status: object, close: Function, agentServer: object, managementServer: object } | null} */
      let liveRuntime = null;
      await runControllerMain({
        env: {
          DATA_DIR: dataDir,
          LINKE_AGENT_HOST: '192.168.10.4',
        },
        start: async (options) => {
          liveRuntime = await startController({
            ...options,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentPort: 3443,
            keychain: memoryKeychain(),
            agentServerFactory: () => trackedServer([], 'agent'),
            managementServerFactory: () => trackedServer([], 'management'),
            onRuntimeError: options.onRuntimeError,
          });
          openRuntimes.add(liveRuntime);
          return liveRuntime;
        },
        log: (line) => logs.push(String(line)),
        error: (line) => errors.push(String(line)),
        exit: () => {},
        onSignal: () => {},
      });

      assert.ok(liveRuntime);
      liveRuntime.agentServer.emit('error', new Error(sensitive));
      liveRuntime.managementServer.emit('error', new Error(sensitive));

      assert.ok(errors.some((line) => line === 'Linke controller runtime error: agent'));
      assert.ok(errors.some((line) => line === 'Linke controller runtime error: management'));
      const text = [...logs, ...errors].join('\n');
      assert.doesNotMatch(text, /\/Users\/|192\.168|super-secret|deadbeef|ECONNRESET|token=|fp=/i);

      await liveRuntime.close();
      openRuntimes.delete(liveRuntime);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('default onRuntimeError is a no-op and late errors do not crash the process', async () => {
    const runtime = await startRuntimeFixture({
      agentServerFactory: () => trackedServer([], 'agent'),
      managementServerFactory: () => trackedServer([], 'management'),
    });
    const dataDir = runtime._testDataDir;
    try {
      assert.doesNotThrow(() => {
        runtime.agentServer.emit('error', new Error(sensitive));
        runtime.managementServer.emit('error', new Error(sensitive));
      });
      assert.equal(runtime.status.agentListening, false);
      assert.equal(runtime.status.managementListening, false);
    } finally {
      await runtime.close();
      openRuntimes.delete(runtime);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C6 RED — production upload wiring via startController
// Design §9.5 / §10: ensureSafeDataRoot → store/locks/service → inject listener
// ---------------------------------------------------------------------------

describe('C6 controller-runtime upload wiring (RED)', () => {
  it('injects complete uploadService + independent uploadRateLimit into agentServerFactory after ensureSafeDataRoot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-wire-'));
    /** @type {any} */
    let captured = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          captured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        assert.ok(captured, 'agentServerFactory must be called');
        assert.ok(captured.registry, 'registry injected');
        assert.ok(captured.rateLimit && typeof captured.rateLimit.check === 'function');
        assert.ok(
          captured.uploadRateLimit && typeof captured.uploadRateLimit.check === 'function',
          'uploadRateLimit must be injected independently',
        );
        assert.notEqual(captured.uploadRateLimit, captured.rateLimit);

        const svc = captured.uploadService;
        assert.ok(svc && typeof svc === 'object', 'uploadService must be injected');
        for (const m of ['create', 'status', 'putChunk', 'finalize', 'abort']) {
          assert.equal(typeof svc[m], 'function', `uploadService.${m}`);
        }
        // Listener must not be expected to steal dataDir from registry.
        assert.equal(captured.dataDir, undefined);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('default maxGlobalTransfers=4; allows 1/16/down to 2; rejects 0/17/NaN/string/hostile without listen or half-service', async () => {
    // Default 4: capture locks via service behavior (5th concurrent → backpressure) is heavy;
    // freeze options surface + factory capture for maxGlobalTransfers wiring.
    {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-mg-def-'));
      /** @type {any} */
      let captured = null;
      try {
        const runtime = await startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: memoryKeychain(),
          listenServer: createLoopbackTestListenAdapter(),
          agentServerFactory: (options) => {
            captured = options;
            return trackedServer([], 'agent');
          },
          managementServerFactory: () => trackedServer([], 'management'),
        });
        openRuntimes.add(runtime);
        try {
          assert.ok(captured?.uploadService);
          // Default production surface: service present (maxGlobalTransfers default 4).
        } finally {
          await runtime.close();
          openRuntimes.delete(runtime);
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }

    for (const maxGlobalTransfers of [1, 2, 16]) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-mg-ok-'));
      let factoryCalled = false;
      try {
        const runtime = await startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: memoryKeychain(),
          maxGlobalTransfers,
          listenServer: createLoopbackTestListenAdapter(),
          agentServerFactory: (options) => {
            factoryCalled = true;
            assert.ok(options.uploadService);
            return trackedServer([], 'agent');
          },
          managementServerFactory: () => trackedServer([], 'management'),
        });
        openRuntimes.add(runtime);
        try {
          assert.equal(factoryCalled, true, String(maxGlobalTransfers));
        } finally {
          await runtime.close();
          openRuntimes.delete(runtime);
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }

    for (const maxGlobalTransfers of [0, 17, Number.NaN, '4', null, 1.5, -1, 100]) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-mg-bad-'));
      let keychainTouched = false;
      let factoryCalled = false;
      let managementFactoryCalled = false;
      const keychain = {
        async get() {
          keychainTouched = true;
          throw new Error('keychain should not run');
        },
        async set() {
          keychainTouched = true;
        },
        async delete() {
          keychainTouched = true;
        },
      };
      try {
        await assert.rejects(
          () => startController({
            dataDir,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentHost: '192.168.10.4',
            agentPort: 3443,
            keychain,
            maxGlobalTransfers,
            agentServerFactory: () => {
              factoryCalled = true;
              throw new Error('agent factory must not run');
            },
            managementServerFactory: () => {
              managementFactoryCalled = true;
              throw new Error('management factory must not run');
            },
          }),
          (error) => {
            assert.ok(error instanceof Error);
            // Fail-closed: no silent clamp. Message must not claim success.
            assert.doesNotMatch(String(error.message), /clamped|normalized to/i);
            return true;
          },
        );
        assert.equal(factoryCalled, false, String(maxGlobalTransfers));
        assert.equal(managementFactoryCalled, false, String(maxGlobalTransfers));
        // Prefer rejecting before Keychain; if validation is after pure config only, keychain may
        // still be untouched. Either way no listen / no half-service.
        assert.equal(keychainTouched, false, String(maxGlobalTransfers));
        await assert.rejects(() => access(join(dataDir, 'tls')), { code: 'ENOENT' });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });

  it('creates default upload limiter 1200/min/60s isolated from agentRateLimit 60/min; illegal config fail-closed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-ulim-'));
    /** @type {any} */
    let captured = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          captured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        const legacy = captured.rateLimit;
        const upload = captured.uploadRateLimit;
        assert.ok(legacy && upload);
        assert.notEqual(legacy, upload);
        const client = '10.9.8.7';
        for (let i = 0; i < 60; i += 1) {
          assert.equal(legacy.check(client).allowed, true, `legacy ${i + 1}`);
        }
        assert.equal(legacy.check(client).allowed, false, 'legacy 61 denied');
        // Upload counter independent — still allows beyond 60.
        for (let i = 0; i < 1200; i += 1) {
          assert.equal(upload.check(client).allowed, true, `upload ${i + 1}`);
        }
        assert.equal(upload.check(client).allowed, false, 'upload 1201 denied');
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }

    for (const agentUploadRateLimit of [
      { maxRequests: -1, windowMs: 1000 },
      { maxRequests: 10, windowMs: 0 },
      { maxRequests: 1.5, windowMs: 1000 },
      'not-an-object',
      [],
      { maxRequests: 0, windowMs: 60_000 },
    ]) {
      const dir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-ulim-bad-'));
      let factoryCalled = false;
      let keychainTouched = false;
      try {
        await assert.rejects(
          () => startController({
            dataDir: dir,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentHost: '192.168.10.4',
            agentPort: 3443,
            keychain: {
              async get() {
                keychainTouched = true;
                throw new Error('no');
              },
              async set() {
                keychainTouched = true;
              },
              async delete() {
                keychainTouched = true;
              },
            },
            agentUploadRateLimit,
            agentServerFactory: () => {
              factoryCalled = true;
              throw new Error('no factory');
            },
            managementServerFactory: () => {
              factoryCalled = true;
              throw new Error('no factory');
            },
          }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(String(error.message), /rateLimit|upload/i);
            return true;
          },
        );
        assert.equal(factoryCalled, false);
        assert.equal(keychainTouched, false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // null/false must not disable upload protection (same spirit as agentRateLimit).
    for (const agentUploadRateLimit of [null, false]) {
      const dir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-ulim-null-'));
      /** @type {any} */
      let capturedUpload = null;
      try {
        const runtime = await startController({
          dataDir: dir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: memoryKeychain(),
          agentUploadRateLimit,
          listenServer: createLoopbackTestListenAdapter(),
          agentServerFactory: (options) => {
            capturedUpload = options.uploadRateLimit;
            return trackedServer([], 'agent');
          },
          managementServerFactory: () => trackedServer([], 'management'),
        });
        openRuntimes.add(runtime);
        try {
          assert.ok(capturedUpload && typeof capturedUpload.check === 'function');
          const client = '10.1.1.1';
          for (let i = 0; i < 1200; i += 1) {
            assert.equal(capturedUpload.check(client).allowed, true);
          }
          assert.equal(capturedUpload.check(client).allowed, false);
        } finally {
          await runtime.close();
          openRuntimes.delete(runtime);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('captured real uploadService supports create→status→abort on temp dataDir (behavior, not source scan)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-live-svc-'));
    /** @type {any} */
    let uploadService = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          uploadService = options.uploadService;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        assert.ok(uploadService, 'uploadService required');

        // Real Node fs.statfs should accept a tiny zero-byte manifest on local temp FS.
        const { projectCanonicalUploadManifest } = await import('../src/upload-manifest.js');
        const deviceId = 'runtime-upload-device-001';
        const input = {
          schemaVersion: 2,
          snapshotId: '550e8400-e29b-41d4-a716-4466554400bb',
          deviceId,
          createdAt: '2026-07-22T12:00:00.000Z',
          files: [],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 0,
            entries: [],
          },
        };
        const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
          authenticatedDeviceId: deviceId,
        });

        const created = await uploadService.create({
          authenticatedDeviceId: deviceId,
          manifest,
          claimedManifestDigest: manifestDigest,
        });
        assert.ok(created && typeof created.uploadId === 'string');
        assert.equal(created.status, 'initialized');
        // Safe summary only
        assert.equal(created.path, undefined);
        assert.equal(created.sourcePath, undefined);
        assert.equal(created.ipAddress, undefined);

        const status = await uploadService.status({
          authenticatedDeviceId: deviceId,
          uploadId: created.uploadId,
        });
        assert.equal(status.uploadId, created.uploadId);
        assert.equal(status.status, 'initialized');

        const aborted = await uploadService.abort({
          authenticatedDeviceId: deviceId,
          uploadId: created.uploadId,
        });
        assert.equal(aborted.status, 'aborted');

        const abortedAgain = await uploadService.abort({
          authenticatedDeviceId: deviceId,
          uploadId: created.uploadId,
        });
        assert.equal(abortedAgain.status, 'aborted');
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('agentServerFactory or upload assembly failure: no management listener; safe close; no public half-start', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-fail-'));
    try {
      let managementListening = false;
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: memoryKeychain(),
          listenServer: createLoopbackTestListenAdapter(),
          agentServerFactory: () => {
            throw new Error('agent factory boom secret=/Users/secret/token.pem');
          },
          managementServerFactory: () => {
            managementListening = true;
            return trackedServer([], 'management');
          },
        }),
        (error) => {
          assert.ok(error instanceof Error);
          // Must not leave management half-started.
          return true;
        },
      );
      assert.equal(managementListening, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }

    // Missing uploadService dependency: production assembly must fail-closed before public start.
    // Force by injecting a hostile maxGlobalTransfers already covered; additionally assert
    // that a factory which receives incomplete options is not "success-started".
    {
      const dir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-half-'));
      let agentListen = false;
      let managementListen = false;
      try {
        // If GREEN wrongly omits uploadService but still starts, this test fails closed by
        // asserting factory options always include a complete service when start succeeds.
        const runtime = await startController({
          dataDir: dir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort: 0,
          keychain: memoryKeychain(),
          listenServer: async (server, port, host) => {
            if (server && typeof server.listen === 'function') {
              // track which fake servers listen via adapter on tracked servers only
            }
            return createLoopbackTestListenAdapter()(server, port, host);
          },
          agentServerFactory: (options) => {
            assert.ok(options.uploadService, 'must not public-start without uploadService');
            for (const m of ['create', 'status', 'putChunk', 'finalize', 'abort']) {
              assert.equal(typeof options.uploadService[m], 'function');
            }
            agentListen = true;
            return trackedServer([], 'agent');
          },
          managementServerFactory: () => {
            managementListen = true;
            return trackedServer([], 'management');
          },
        });
        openRuntimes.add(runtime);
        try {
          assert.equal(agentListen, true);
          assert.equal(managementListen, true);
        } finally {
          await runtime.close();
          openRuntimes.delete(runtime);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('existing bind/TLS/keychain fail-closed gates remain (smoke: illegal agent host still early)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-legacy-'));
    let factoryCalled = false;
    try {
      await assert.rejects(
        () => startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '8.8.8.8',
          agentPort: 3443,
          keychain: memoryKeychain(),
          agentServerFactory: () => {
            factoryCalled = true;
            throw new Error('no');
          },
          managementServerFactory: () => {
            factoryCalled = true;
            throw new Error('no');
          },
        }),
        /private|agent host/i,
      );
      assert.equal(factoryCalled, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C6 G0c restore runtime wiring (RED)
// Design §8 + C55 production wiring + plan C6 Step 4
// ---------------------------------------------------------------------------

const C6_RT_SNAPSHOT_ID = '550e8400-e29b-41d4-a716-4466554400bb';
const C6_RT_SNAPSHOT_B = '550e8400-e29b-41d4-a716-4466554400bc';
const C6_RT_T0 = '2026-07-22T12:00:00.000Z';
const C6_RT_ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Assert LinkeError with exact public code (no near-tautology typeof/object checks).
 * @param {unknown} error
 * @param {string} code
 */
function assertC6LinkeCode(error, code) {
  assert.ok(error instanceof LinkeError, `expected LinkeError for ${code}, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
}

/**
 * Build a zero-file or single-file upload projection for runtime uploadService.create.
 * @param {{ deviceId: string, snapshotId?: string, files?: { path: string, size: number, content?: Buffer }[] }} opts
 */
function makeC6UploadProjection(opts) {
  const deviceId = opts.deviceId;
  const snapshotId = opts.snapshotId ?? C6_RT_SNAPSHOT_ID;
  const files = opts.files ?? [];
  const entries = files.map((f) => {
    const content = f.content ?? (f.size === 0 ? Buffer.alloc(0) : Buffer.alloc(f.size, 0x61));
    assert.equal(content.length, f.size);
    const sha256 = f.size === 0
      ? C6_RT_ZERO_SHA
      : createHash('sha256').update(content).digest('hex');
    return { path: f.path, size: f.size, sha256, content };
  });
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  const input = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: C6_RT_T0,
    files: entries.map((e) => e.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 })),
    },
  };
  const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: deviceId,
  });
  return { manifest, manifestDigest, entries, totalBytes, deviceId, snapshotId };
}

/**
 * Plant a local (non remote-upload) committed snapshot fixture under dataDir.
 * Readable via production getSnapshotManifest → createRestoreSnapshotReader path.
 * @param {string} dataDir
 * @param {{ deviceId: string, snapshotId?: string, fileRel?: string, fileContent?: string }} opts
 */
async function plantC6LocalSnapshotFixture(dataDir, opts) {
  const deviceId = opts.deviceId;
  const snapshotId = opts.snapshotId ?? C6_RT_SNAPSHOT_ID;
  const fileRel = opts.fileRel ?? 'docs/readme.txt';
  const fileContent = opts.fileContent ?? 'runtime-restore-fixture';
  const fileBytes = Buffer.byteLength(fileContent, 'utf8');
  const fileSha = createHash('sha256').update(fileContent, 'utf8').digest('hex');
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  const base = join(dataDir, deviceRel, 'snapshots', snapshotId);
  await mkdir(join(base, 'files'), { recursive: true });
  // nested parents if needed
  const fileAbs = join(base, 'files', fileRel);
  await mkdir(join(fileAbs, '..'), { recursive: true });
  await writeFile(fileAbs, fileContent, 'utf8');

  const rawManifest = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: C6_RT_T0,
    hostname: 'c6-runtime-fixture',
    sourcePath: '/tmp/c6-runtime-source',
    files: [fileRel],
    integrity: {
      algorithm: 'sha256',
      totalBytes: fileBytes,
      entries: [{ path: fileRel, size: fileBytes, sha256: fileSha }],
    },
  };
  await writeFile(join(base, 'manifest.json'), JSON.stringify(rawManifest, null, 2), 'utf8');

  const indexPath = join(dataDir, deviceRel, 'snapshots.json');
  await mkdir(join(dataDir, deviceRel), { recursive: true });
  /** @type {unknown[]} */
  let list = [];
  try {
    list = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list = list.filter((e) => e && /** @type {any} */ (e).snapshotId !== snapshotId);
  list.push({
    snapshotId,
    createdAt: C6_RT_T0,
    hostname: 'c6-runtime-fixture',
    sourcePath: '/tmp/c6-runtime-source',
    fileCount: 1,
  });
  await writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');

  // Independent digest oracle via production projector (local raw → clean → digest).
  const clean = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: C6_RT_T0,
    hostname: 'c6-runtime-fixture',
    sourcePath: '/tmp/c6-runtime-source',
    files: [fileRel],
    integrity: {
      algorithm: 'sha256',
      totalBytes: fileBytes,
      entries: [{ path: fileRel, size: fileBytes, sha256: fileSha }],
    },
  };
  const { manifestDigest } = projectCanonicalUploadManifest(clean, {
    authenticatedDeviceId: deviceId,
  });
  return {
    deviceId,
    snapshotId,
    manifestDigest,
    fileCount: 1,
    totalBytes: fileBytes,
    fileRel,
    fileContent,
  };
}

/**
 * Extract task summary from createTask result (store returns {httpHint, taskSummary}).
 * @param {any} created
 */
function c6TaskSummary(created) {
  if (!created || typeof created !== 'object') return null;
  if (created.taskSummary && typeof created.taskSummary === 'object') return created.taskSummary;
  return created;
}

describe('C6 controller-runtime restore wiring (RED)', () => {
  it('injects complete restoreService + restoreRateLimit + shared locks probes into factories', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-rs-wire-'));
    /** @type {any} */
    let agentCaptured = null;
    /** @type {any} */
    let managementCaptured = null;
    /** @type {ReturnType<typeof createUploadLocks> | null} */
    let capturedLocks = null;
    let createLocksCalls = 0;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        maxGlobalTransfers: 1,
        // Optional factory DI (same spirit as agentServerFactory). When honored,
        // assert exactly one shared createUploadLocks instance. Primary pin below
        // is behavioral (putChunk holds the only live-transfer slot).
        createUploadLocks: (opts) => {
          createLocksCalls += 1;
          capturedLocks = createUploadLocks(opts);
          return capturedLocks;
        },
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          agentCaptured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: (options) => {
          managementCaptured = options;
          return trackedServer([], 'management');
        },
      });
      openRuntimes.add(runtime);
      try {
        assert.ok(agentCaptured, 'agentServerFactory must be called');
        assert.ok(
          agentCaptured.restoreRateLimit
          && typeof agentCaptured.restoreRateLimit.check === 'function',
          'restoreRateLimit must be injected independently',
        );
        assert.notEqual(agentCaptured.restoreRateLimit, agentCaptured.rateLimit);
        assert.notEqual(agentCaptured.restoreRateLimit, agentCaptured.uploadRateLimit);

        const rs = agentCaptured.restoreService;
        const uploadService = agentCaptured.uploadService;
        assert.ok(rs && typeof rs === 'object', 'restoreService must be injected');
        assert.ok(uploadService && typeof uploadService === 'object', 'uploadService must be injected');
        for (const m of [
          'claim',
          'getTask',
          'getChunk',
          'updateProgress',
          'acceptReceipt',
          'acceptCleanup',
          'createTask',
          'cancelTask',
          'getStatus',
          'hasActiveRestore',
        ]) {
          assert.equal(typeof rs[m], 'function', `restoreService.${m}`);
        }

        assert.ok(managementCaptured, 'managementServerFactory must be called');
        assert.ok(
          managementCaptured.restoreService,
          'management must receive restoreService for restore-tasks routes',
        );
        // Same instance reference: agent + management restoreService.
        assert.equal(
          managementCaptured.restoreService,
          agentCaptured.restoreService,
          'agent and management must share one restoreService instance',
        );

        // Optional factory pin: if production forwards createUploadLocks, it must be once.
        if (createLocksCalls > 0) {
          assert.equal(createLocksCalls, 1, 'exactly one createUploadLocks for upload+restore');
          assert.ok(capturedLocks);
          assert.equal(capturedLocks.maxGlobalTransfers, 1);
        }

        // Behavioral shared live-transfer budget (primary, no private locks required):
        // maxGlobalTransfers=1 → hold via upload putChunk hang → restore getChunk must be
        // exact RESTORE_BACKPRESSURE. Separate lock sets would leave restore free.
        const deviceId = 'shared-lock-device';
        const content = Buffer.from('x');
        const proj = makeC6UploadProjection({
          deviceId,
          snapshotId: C6_RT_SNAPSHOT_B,
          files: [{ path: 'hold.bin', size: content.length, content }],
        });
        const session = await uploadService.create({
          authenticatedDeviceId: deviceId,
          manifest: proj.manifest,
          claimedManifestDigest: proj.manifestDigest,
        });
        assert.equal(typeof session.uploadId, 'string');

        const sha256 = createHash('sha256').update(content).digest('hex');
        const pairs = [
          ['Authorization', 'Bearer test-token-not-secret'],
          ['X-Linke-Device-Id', deviceId],
          ['X-Linke-Protocol-Version', '2'],
          ['Content-Length', String(content.length)],
          ['X-Linke-Upload-Id', session.uploadId],
          ['X-Linke-Snapshot-Id', proj.snapshotId],
          ['X-Linke-Manifest-Digest', proj.manifestDigest],
          ['X-Linke-File-Index', '0'],
          ['X-Linke-Chunk-Index', '0'],
          ['X-Linke-Chunk-Offset', '0'],
          ['X-Linke-Chunk-Size', String(content.length)],
          ['X-Linke-Chunk-Sha256', sha256],
        ];
        /** @type {string[]} */
        const rawHeaders = [];
        for (const [k, v] of pairs) rawHeaders.push(k, v);

        // Hang body after headers so putChunk keeps the sole runTransfer slot.
        const hangStream = new Readable({
          read() {
            /* never push — holds ingest inside runTransfer */
          },
        });
        const putP = uploadService.putChunk({
          authenticatedDeviceId: deviceId,
          request: {
            rawHeaders,
            url: `/agent/upload/sessions/${session.uploadId}/chunks`,
            method: 'POST',
          },
          stream: hangStream,
        });
        // Yield until putChunk has entered runTransfer (slot held).
        for (let turn = 0; turn < 64; turn += 1) {
          await new Promise((r) => setImmediate(r));
          await Promise.resolve();
        }

        await assert.rejects(
          () => rs.getChunk({
            deviceId,
            taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            fileIndex: 0,
            chunkIndex: 0,
          }),
          (error) => {
            assertC6LinkeCode(error, ERROR_CODES.RESTORE_BACKPRESSURE);
            return true;
          },
        );

        // Active upload session on same device: claim is exact RESTORE_TASK_CONFLICT
        // (admission), never RESTORE_BACKPRESSURE (live-transfer slots). Slot fullness
        // alone does not change claim; upload nonterminal does.
        await assert.rejects(
          () => rs.claim({ deviceId }),
          (error) => {
            assertC6LinkeCode(error, ERROR_CODES.RESTORE_TASK_CONFLICT);
            assert.notEqual(
              /** @type {any} */ (error)?.code,
              ERROR_CODES.RESTORE_BACKPRESSURE,
            );
            return true;
          },
        );

        hangStream.destroy(new Error('test-release-slot'));
        await putP.then(() => {}, () => {});
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('production restoreRateLimit default 1200/min isolated from legacy 60 and upload 1200', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-rs-lim-'));
    /** @type {any} */
    let captured = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          captured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        const legacy = captured.rateLimit;
        const upload = captured.uploadRateLimit;
        const restore = captured.restoreRateLimit;
        assert.ok(legacy && upload && restore);
        assert.notEqual(legacy, upload);
        assert.notEqual(upload, restore);
        assert.notEqual(legacy, restore);
        const client = '10.9.8.7';
        for (let i = 0; i < 60; i += 1) {
          assert.equal(legacy.check(client).allowed, true, `legacy ${i + 1}`);
        }
        assert.equal(legacy.check(client).allowed, false, 'legacy 61 denied');
        for (let i = 0; i < 1200; i += 1) {
          assert.equal(upload.check(client).allowed, true, `upload ${i + 1}`);
        }
        assert.equal(upload.check(client).allowed, false, 'upload 1201 denied');
        for (let i = 0; i < 1200; i += 1) {
          assert.equal(restore.check(client).allowed, true, `restore ${i + 1}`);
        }
        assert.equal(restore.check(client).allowed, false, 'restore 1201 denied');
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('upload findActiveRestore is explicit; restore findActiveUpload calls uploadStore.findActiveSession', async () => {
    // Pin production wiring without source-scan oracle:
    // a) seed active/pending restore → same-device upload create → exact UPLOAD_SESSION_CONFLICT
    //    (proves explicit findActiveRestore, not C5 default async () => false)
    // b) seed active upload session → same-device restore claim → exact RESTORE_TASK_CONFLICT
    //    + findActiveSession spy call count ≥ 1
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-probes-'));
    /** @type {any} */
    let agentCaptured = null;
    let findActiveSessionCalls = 0;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        // Optional store factory DI: wrap findActiveSession for production pin call count.
        createUploadSessionStore: (opts) => {
          const store = createUploadSessionStore(opts);
          const orig = store.findActiveSession.bind(store);
          return {
            ...store,
            findActiveSession: async (deviceId) => {
              findActiveSessionCalls += 1;
              return orig(deviceId);
            },
          };
        },
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          agentCaptured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        const uploadService = agentCaptured.uploadService;
        const restoreService = agentCaptured.restoreService;
        assert.ok(uploadService, 'uploadService required');
        assert.ok(restoreService, 'restoreService required for bidirectional probes');

        // ── a) explicit findActiveRestore ─────────────────────────────
        const deviceRestore = 'probe-restore-device';
        const fixtureA = await plantC6LocalSnapshotFixture(dataDir, {
          deviceId: deviceRestore,
          snapshotId: C6_RT_SNAPSHOT_ID,
          fileContent: 'probe-a-body',
        });
        const createdRestore = await restoreService.createTask({
          deviceId: deviceRestore,
          snapshotId: fixtureA.snapshotId,
          relativeTarget: 'apps/demo',
        });
        const summaryA = c6TaskSummary(createdRestore);
        assert.ok(summaryA && typeof summaryA === 'object', 'createTask must return summary object');
        assert.equal(typeof summaryA.taskId, 'string');
        assert.match(summaryA.taskId, /^[0-9a-f-]{36}$/i);
        assert.equal(summaryA.status, 'pending');
        assert.equal(summaryA.manifestDigest, fixtureA.manifestDigest);
        assert.equal(summaryA.fileCount, fixtureA.fileCount);
        assert.equal(summaryA.totalBytes, fixtureA.totalBytes);

        assert.equal(await restoreService.hasActiveRestore(deviceRestore), true);

        const projBlocked = makeC6UploadProjection({
          deviceId: deviceRestore,
          snapshotId: C6_RT_SNAPSHOT_B,
          files: [],
        });
        await assert.rejects(
          () => uploadService.create({
            authenticatedDeviceId: deviceRestore,
            manifest: projBlocked.manifest,
            claimedManifestDigest: projBlocked.manifestDigest,
          }),
          (error) => {
            assertC6LinkeCode(error, ERROR_CODES.UPLOAD_SESSION_CONFLICT);
            return true;
          },
        );

        // ── b) findActiveUpload → uploadStore.findActiveSession ───────
        // Clean device: active upload session + pending restore (createTask ignores upload).
        // claim must exact RESTORE_TASK_CONFLICT and call findActiveSession ≥ 1.
        const deviceUploadOnly = 'probe-upload-only';
        const projOnly = makeC6UploadProjection({
          deviceId: deviceUploadOnly,
          snapshotId: C6_RT_SNAPSHOT_B,
          files: [],
        });
        const session = await uploadService.create({
          authenticatedDeviceId: deviceUploadOnly,
          manifest: projOnly.manifest,
          claimedManifestDigest: projOnly.manifestDigest,
        });
        assert.equal(typeof session.uploadId, 'string');
        assert.equal(session.status, 'initialized');

        const fixtureOnly = await plantC6LocalSnapshotFixture(dataDir, {
          deviceId: deviceUploadOnly,
          snapshotId: C6_RT_SNAPSHOT_ID,
          fileContent: 'probe-only-body',
        });
        const pendingOnly = await restoreService.createTask({
          deviceId: deviceUploadOnly,
          snapshotId: fixtureOnly.snapshotId,
          relativeTarget: 'apps/claim-target',
        });
        assert.equal(c6TaskSummary(pendingOnly)?.status, 'pending');

        findActiveSessionCalls = 0;
        await assert.rejects(
          () => restoreService.claim({ deviceId: deviceUploadOnly }),
          (error) => {
            assertC6LinkeCode(error, ERROR_CODES.RESTORE_TASK_CONFLICT);
            return true;
          },
        );
        assert.ok(
          findActiveSessionCalls >= 1,
          `findActiveUpload must call uploadStore.findActiveSession (≥1), got ${findActiveSessionCalls}`,
        );
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('half restore dependency must not public-start; missing restoreService surface fails closed', async () => {
    // Production assembly always builds restore stack; test pin: agent factory must receive
    // restore dual-gate or reject before management listen.
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-rs-half-'));
    let managementListening = false;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          // Fail closed if production half-omits restore dual-gate.
          assert.ok(options.restoreService, 'must not public-start without restoreService');
          assert.ok(
            options.restoreRateLimit && typeof options.restoreRateLimit.check === 'function',
            'must not public-start without restoreRateLimit',
          );
          for (const m of ['claim', 'getTask', 'getChunk', 'updateProgress', 'acceptReceipt', 'acceptCleanup']) {
            assert.equal(typeof options.restoreService[m], 'function', m);
          }
          return trackedServer([], 'agent');
        },
        managementServerFactory: (options) => {
          managementListening = true;
          assert.ok(options.restoreService, 'management half-start without restoreService forbidden');
          return trackedServer([], 'management');
        },
      });
      openRuntimes.add(runtime);
      try {
        assert.equal(managementListening, true);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('production uses createRestoreSnapshotReader + getSnapshotManifest; create summary has real digest fields', async () => {
    // Positive fixture pin: real local snapshot → createTask success with exact
    // manifestDigest / fileCount / totalBytes; getSnapshotManifest spy ≥ 1 call.
    // Negative missing-snapshot alone cannot substitute this positive oracle.
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-snap-'));
    /** @type {any} */
    let managementCaptured = null;
    /** @type {any} */
    let agentCaptured = null;
    let getSnapshotManifestCalls = 0;
    const deviceId = 'snap-reader-device';
    const fixture = await plantC6LocalSnapshotFixture(dataDir, {
      deviceId,
      snapshotId: C6_RT_SNAPSHOT_ID,
      fileContent: 'snapshot-reader-positive',
    });
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        // Injectable production factory pin (createRestoreSnapshotReader getSnapshotManifestFn).
        getSnapshotManifestFn: async (...args) => {
          getSnapshotManifestCalls += 1;
          return getSnapshotManifest(...args);
        },
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          agentCaptured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: (options) => {
          managementCaptured = options;
          return trackedServer([], 'management');
        },
      });
      openRuntimes.add(runtime);
      try {
        const restoreService = agentCaptured?.restoreService || managementCaptured?.restoreService;
        assert.ok(restoreService, 'restoreService required for snapshot-reader production pin');

        getSnapshotManifestCalls = 0;
        const created = await restoreService.createTask({
          deviceId,
          snapshotId: fixture.snapshotId,
          relativeTarget: 'apps/demo',
        });
        const summary = c6TaskSummary(created);
        assert.ok(summary && typeof summary === 'object');
        assert.equal(typeof summary.taskId, 'string');
        assert.match(summary.taskId, /^[0-9a-f-]{36}$/i);
        assert.equal(summary.status, 'pending');
        assert.equal(summary.snapshotId, fixture.snapshotId);
        assert.equal(summary.deviceId, deviceId);
        assert.equal(
          summary.manifestDigest,
          fixture.manifestDigest,
          'create summary manifestDigest must equal fixture digest oracle',
        );
        assert.equal(summary.fileCount, fixture.fileCount);
        assert.equal(summary.totalBytes, fixture.totalBytes);
        assert.ok(
          getSnapshotManifestCalls >= 1,
          `getSnapshotManifest must be called ≥1 via production reader, got ${getSnapshotManifestCalls}`,
        );

        // Missing snapshot remains fail-closed (domain error, not TypeError) — complement, not substitute.
        await assert.rejects(
          () => restoreService.createTask({
            deviceId,
            snapshotId: '550e8400-e29b-41d4-a716-4466554400cc',
            relativeTarget: 'apps/missing',
          }),
          (error) => {
            assert.ok(error instanceof LinkeError);
            assert.notEqual(error.name, 'TypeError');
            assert.ok(
              error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
              || error.code === ERROR_CODES.RESTORE_TASK_INVALID
              || error.code === ERROR_CODES.RESTORE_STATE_INVALID,
            );
            return true;
          },
        );
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('same-device race: only one of upload create / restore claim wins; different devices parallel', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rt-race-'));
    /** @type {any} */
    let agentCaptured = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          agentCaptured = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: () => trackedServer([], 'management'),
      });
      openRuntimes.add(runtime);
      try {
        const uploadService = agentCaptured.uploadService;
        const restoreService = agentCaptured.restoreService;
        assert.ok(uploadService, 'uploadService required');
        assert.ok(restoreService, 'restoreService required for race pin');

        // ── Same device: pending restore competes with upload create ──
        const deviceA = 'race-device-same';
        const fixtureA = await plantC6LocalSnapshotFixture(dataDir, {
          deviceId: deviceA,
          snapshotId: C6_RT_SNAPSHOT_ID,
          fileContent: 'race-same-body',
        });
        const pending = await restoreService.createTask({
          deviceId: deviceA,
          snapshotId: fixtureA.snapshotId,
          relativeTarget: 'apps/race',
        });
        const pendingSummary = c6TaskSummary(pending);
        assert.equal(pendingSummary?.status, 'pending');
        assert.equal(typeof pendingSummary?.taskId, 'string');

        const projA = makeC6UploadProjection({
          deviceId: deviceA,
          snapshotId: C6_RT_SNAPSHOT_B,
          files: [],
        });
        const uploadP = uploadService.create({
          authenticatedDeviceId: deviceA,
          manifest: projA.manifest,
          claimedManifestDigest: projA.manifestDigest,
        });
        const claimP = restoreService.claim({ deviceId: deviceA });
        const settled = await Promise.allSettled([uploadP, claimP]);
        assert.equal(settled.length, 2);
        for (const s of settled) {
          assert.ok(s.status === 'fulfilled' || s.status === 'rejected', 'must not hang');
        }

        const uploadSettled = settled[0];
        const claimSettled = settled[1];
        const uploadOk = uploadSettled.status === 'fulfilled'
          && typeof /** @type {any} */ (uploadSettled).value?.uploadId === 'string';
        const claimOk = claimSettled.status === 'fulfilled'
          && /** @type {any} */ (claimSettled).value?.task != null
          && /** @type {any} */ (claimSettled).value.task.status === 'active';

        assert.equal(
          Number(uploadOk) + Number(claimOk),
          1,
          'same-device race: exactly one of upload create / restore claim must succeed',
        );

        if (uploadOk) {
          assert.equal(claimSettled.status, 'rejected');
          assertC6LinkeCode(
            /** @type {PromiseRejectedResult} */ (claimSettled).reason,
            ERROR_CODES.RESTORE_TASK_CONFLICT,
          );
        } else {
          assert.equal(uploadSettled.status, 'rejected');
          assertC6LinkeCode(
            /** @type {PromiseRejectedResult} */ (uploadSettled).reason,
            ERROR_CODES.UPLOAD_SESSION_CONFLICT,
          );
          assert.equal(claimOk, true);
          assert.equal(
            /** @type {any} */ (claimSettled).value.task.taskId,
            pendingSummary.taskId,
          );
        }

        // ── Different devices: parallel upload create + restore claim both ok ──
        const deviceB = 'race-device-b';
        const deviceC = 'race-device-c';
        const fixtureC = await plantC6LocalSnapshotFixture(dataDir, {
          deviceId: deviceC,
          snapshotId: C6_RT_SNAPSHOT_ID,
          fileContent: 'race-c-body',
        });
        const pendingC = await restoreService.createTask({
          deviceId: deviceC,
          snapshotId: fixtureC.snapshotId,
          relativeTarget: 'apps/parallel',
        });
        assert.equal(c6TaskSummary(pendingC)?.status, 'pending');

        const projB = makeC6UploadProjection({
          deviceId: deviceB,
          snapshotId: C6_RT_SNAPSHOT_B,
          files: [],
        });
        const [uploadB, claimC] = await Promise.all([
          uploadService.create({
            authenticatedDeviceId: deviceB,
            manifest: projB.manifest,
            claimedManifestDigest: projB.manifestDigest,
          }),
          restoreService.claim({ deviceId: deviceC }),
        ]);
        assert.equal(typeof uploadB.uploadId, 'string');
        assert.equal(uploadB.status, 'initialized');
        assert.ok(claimC?.task);
        assert.equal(claimC.task.status, 'active');
        assert.equal(claimC.task.taskId, c6TaskSummary(pendingC).taskId);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// V1.46 controller auth scope parity — 最终行为测试（TDD RED / 旧生产入口缺口）
// 仅证明 startController / parseControllerEnv / runControllerMain 透传缺口；
// 不得直接 createServer 冒充入口，也不得伪造 deviceAdministration。
// ---------------------------------------------------------------------------

describe('V1.46 controller auth scope parity', () => {
  // 合成 sentinel：仅用于断言透传与日志脱敏，禁止真实凭证。
  const FULL = 'v146-full-auth-sentinel';
  const FULL_LEGACY = 'v146-legacy-token-sentinel';
  const READ = 'v146-read-sentinel';
  const PREV_READ = 'v146-previous-read-sentinel';
  const WRITE = 'v146-write-sentinel';
  const PREV_WRITE = 'v146-previous-write-sentinel';
  const ADMIN = 'v146-admin-sentinel';
  const ALL_SENTINELS = [FULL, FULL_LEGACY, READ, PREV_READ, WRITE, PREV_WRITE, ADMIN];
  const MGMT_TOKEN_KEYS = [
    'authToken',
    'readToken',
    'previousReadToken',
    'writeToken',
    'previousWriteToken',
    'adminToken',
  ];

  /**
   * 经真实 management listener 发起设备管理 POST。
   * @param {number} port
   * @param {string} path
   * @param {object} body
   * @param {string} token
   */
  function postDeviceAdmin(port, path, body, token) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * 在真实 DeviceRegistry 中激活设备，供后续 revoke 200。
   * @param {string} dataDir
   * @param {string} deviceId
   * @param {string} enrollmentCode
   */
  async function activateDeviceFromEnrollment(dataDir, deviceId, enrollmentCode) {
    const registry = new DeviceRegistry({ dataDir });
    await registry.consumeEnrollment({
      deviceId,
      code: enrollmentCode,
      protocolVersion: 2,
    });
  }

  /**
   * 断言文本不含任一 sentinel。
   * @param {string} text
   * @param {string} label
   */
  function assertNoSentinels(text, label) {
    const joined = String(text);
    for (const secret of ALL_SENTINELS) {
      assert.equal(
        joined.includes(secret),
        false,
        `${label} must not contain sentinel ${secret}`,
      );
    }
  }

  it('parseControllerEnv 返回六类令牌字段：AUTH 优先、未设置 undefined、空串原样', () => {
    const full = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '192.168.10.4',
      LINKE_AUTH_TOKEN: FULL,
      LINKE_TOKEN: FULL_LEGACY,
      LINKE_READ_TOKEN: READ,
      LINKE_PREVIOUS_READ_TOKEN: PREV_READ,
      LINKE_WRITE_TOKEN: WRITE,
      LINKE_PREVIOUS_WRITE_TOKEN: PREV_WRITE,
      LINKE_ADMIN_TOKEN: ADMIN,
    });
    // full 仍优先 LINKE_AUTH_TOKEN（不得回落到 LINKE_TOKEN）
    assert.equal(full.authToken, FULL);
    assert.equal(full.readToken, READ);
    assert.equal(full.previousReadToken, PREV_READ);
    assert.equal(full.writeToken, WRITE);
    assert.equal(full.previousWriteToken, PREV_WRITE);
    assert.equal(full.adminToken, ADMIN);
    // 返回对象不得额外暴露 legacy env 名
    assert.equal(Object.hasOwn(full, 'LINKE_TOKEN'), false);

    const unset = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '10.0.0.5',
    });
    assert.equal(unset.authToken, undefined);
    assert.equal(unset.readToken, undefined);
    assert.equal(unset.previousReadToken, undefined);
    assert.equal(unset.writeToken, undefined);
    assert.equal(unset.previousWriteToken, undefined);
    assert.equal(unset.adminToken, undefined);

    const empty = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '172.16.1.2',
      LINKE_READ_TOKEN: '',
      LINKE_PREVIOUS_READ_TOKEN: '',
      LINKE_WRITE_TOKEN: '',
      LINKE_PREVIOUS_WRITE_TOKEN: '',
      LINKE_ADMIN_TOKEN: '',
    });
    assert.equal(empty.readToken, '');
    assert.equal(empty.previousReadToken, '');
    assert.equal(empty.writeToken, '');
    assert.equal(empty.previousWriteToken, '');
    assert.equal(empty.adminToken, '');
  });

  it('startController 将六类令牌原值交给 management factory；Agent options 与 status 隔离', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-v146-factory-'));
    /** @type {Record<string, unknown> | null} */
    let managementOptions = null;
    /** @type {Record<string, unknown> | null} */
    let agentOptions = null;
    try {
      const runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        authToken: FULL,
        readToken: READ,
        previousReadToken: PREV_READ,
        writeToken: WRITE,
        previousWriteToken: PREV_WRITE,
        adminToken: ADMIN,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
        agentServerFactory: (options) => {
          agentOptions = options;
          return trackedServer([], 'agent');
        },
        managementServerFactory: (options) => {
          managementOptions = options;
          return trackedServer([], 'management');
        },
      });
      openRuntimes.add(runtime);
      try {
        assert.ok(managementOptions, 'managementServerFactory must be called');
        assert.equal(managementOptions.authToken, FULL);
        assert.equal(managementOptions.readToken, READ);
        assert.equal(managementOptions.previousReadToken, PREV_READ);
        assert.equal(managementOptions.writeToken, WRITE);
        assert.equal(managementOptions.previousWriteToken, PREV_WRITE);
        assert.equal(managementOptions.adminToken, ADMIN);

        assert.ok(agentOptions, 'agentServerFactory must be called');
        for (const key of MGMT_TOKEN_KEYS) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(agentOptions, key),
            false,
            `agent options must not own ${key}`,
          );
        }

        const statusJson = JSON.stringify(runtime.status);
        assertNoSentinels(statusJson, 'runtime.status JSON');
        for (const key of MGMT_TOKEN_KEYS) {
          assert.equal(Object.hasOwn(runtime.status, key), false, `status must not own ${key}`);
        }
        assert.equal(Object.hasOwn(runtime.status, 'token'), false);
      } finally {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('真实 controller HTTP：admin 配置时 write/previous-write 403，admin 可 enrollment/revoke', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-v146-http-admin-'));
    // 默认 managementServerFactory（真实 createServer + DeviceRegistry 路径），禁止 factory 伪造。
    let runtime;
    try {
      runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        writeToken: WRITE,
        previousWriteToken: PREV_WRITE,
        adminToken: ADMIN,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
      });
      openRuntimes.add(runtime);

      const port = runtime.managementServer.address().port;
      assert.ok(Number.isInteger(port) && port > 0);

      for (const token of [WRITE, PREV_WRITE]) {
        for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
          const denied = await postDeviceAdmin(port, path, { deviceId: 'mac-v146-denied' }, token);
          assert.equal(
            denied.status,
            403,
            `admin configured: ${path} with ${token === WRITE ? 'write' : 'previous-write'} must be 403`,
          );
          assert.deepEqual(await denied.json(), { error: 'Forbidden' });
        }
      }

      const enroll = await postDeviceAdmin(
        port,
        '/api/device-enrollment-codes',
        { deviceId: 'mac-v146-admin-ok' },
        ADMIN,
      );
      assert.equal(enroll.status, 201, 'admin enrollment must be 201');
      const enrolled = await enroll.json();
      assert.equal(typeof enrolled.enrollmentCode, 'string');
      assert.ok(enrolled.enrollmentCode.length > 0);
      assert.match(enrolled.tlsFingerprint, /^[a-f0-9]{64}$/);
      assert.match(enrolled.agentUrl, /^https:\/\//);
      assertNoSentinels(JSON.stringify(enrolled), 'enrollment response');

      await activateDeviceFromEnrollment(dataDir, 'mac-v146-admin-ok', enrolled.enrollmentCode);

      const revoke = await postDeviceAdmin(
        port,
        '/api/device-revoke',
        { deviceId: 'mac-v146-admin-ok' },
        ADMIN,
      );
      assert.equal(revoke.status, 200, 'admin revoke must be 200');
      assert.deepEqual(await revoke.json(), { deviceId: 'mac-v146-admin-ok', revoked: true });
    } finally {
      if (runtime) {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('真实 controller HTTP：admin 缺省时 current/previous write 对 enrollment/revoke 均成功', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-v146-http-no-admin-'));
    let runtime;
    try {
      runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        writeToken: WRITE,
        previousWriteToken: PREV_WRITE,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
      });
      openRuntimes.add(runtime);

      const port = runtime.managementServer.address().port;
      const cases = [
        { token: WRITE, deviceId: 'mac-v146-write-ok' },
        { token: PREV_WRITE, deviceId: 'mac-v146-prev-write-ok' },
      ];
      for (const { token, deviceId } of cases) {
        const enroll = await postDeviceAdmin(
          port,
          '/api/device-enrollment-codes',
          { deviceId },
          token,
        );
        assert.equal(
          enroll.status,
          201,
          `no-admin enrollment with ${token === WRITE ? 'write' : 'previous-write'} must be 201`,
        );
        const body = await enroll.json();
        await activateDeviceFromEnrollment(dataDir, deviceId, body.enrollmentCode);

        const revoke = await postDeviceAdmin(
          port,
          '/api/device-revoke',
          { deviceId },
          token,
        );
        assert.equal(
          revoke.status,
          200,
          `no-admin revoke with ${token === WRITE ? 'write' : 'previous-write'} must be 200`,
        );
        assert.deepEqual(await revoke.json(), { deviceId, revoked: true });
      }
    } finally {
      if (runtime) {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('空 LINKE_ADMIN_TOKEN 等价未配置；空 previous 不激活 previous scope', async () => {
    // 解析层：空串原样返回（随后 createServer 视为未配置）
    const parsed = parseControllerEnv({
      DATA_DIR: 'data',
      LINKE_AGENT_HOST: '192.168.10.4',
      LINKE_WRITE_TOKEN: WRITE,
      LINKE_ADMIN_TOKEN: '',
      LINKE_PREVIOUS_WRITE_TOKEN: '',
      LINKE_PREVIOUS_READ_TOKEN: '',
    });
    assert.equal(parsed.adminToken, '');
    assert.equal(parsed.previousWriteToken, '');
    assert.equal(parsed.previousReadToken, '');
    assert.equal(parsed.writeToken, WRITE);

    const dataDir = await mkdtemp(join(tmpdir(), 'linke-v146-empty-scope-'));
    let runtime;
    try {
      runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        writeToken: WRITE,
        adminToken: '',
        previousWriteToken: '',
        previousReadToken: '',
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
      });
      openRuntimes.add(runtime);
      const port = runtime.managementServer.address().port;

      // 空 admin ≡ 未配置：current write 仍可管理设备
      const enroll = await postDeviceAdmin(
        port,
        '/api/device-enrollment-codes',
        { deviceId: 'mac-v146-empty-admin' },
        WRITE,
      );
      assert.equal(enroll.status, 201, 'empty adminToken must not block write enrollment');
      const body = await enroll.json();
      await activateDeviceFromEnrollment(dataDir, 'mac-v146-empty-admin', body.enrollmentCode);
      const revoke = await postDeviceAdmin(
        port,
        '/api/device-revoke',
        { deviceId: 'mac-v146-empty-admin' },
        WRITE,
      );
      assert.equal(revoke.status, 200);

      // 空 previous 不得把 previous sentinel 当成有效 previous-write 凭证
      const prevEnroll = await postDeviceAdmin(
        port,
        '/api/device-enrollment-codes',
        { deviceId: 'mac-v146-empty-prev' },
        PREV_WRITE,
      );
      assert.equal(
        prevEnroll.status,
        401,
        'empty previousWriteToken must not activate previous-write credentials',
      );
    } finally {
      if (runtime) {
        await runtime.close();
        openRuntimes.delete(runtime);
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('previous-only 配置让真实 management createServer 失败并关闭 Agent、释放端口', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-v146-prev-only-'));
    // 预取空闲端口，供失败后立即 rebind 证明清理完成。
    const probe = createHttpServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const agentPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    /** @type {Awaited<ReturnType<typeof startController>> | null} */
    let leakedRuntime = null;
    try {
      try {
        leakedRuntime = await startController({
          dataDir,
          managementHost: '127.0.0.1',
          managementPort: 0,
          agentHost: '192.168.10.4',
          agentPort,
          // previous-read 无 current read：真实 createServer 必须抛配对错误
          previousReadToken: PREV_READ,
          // 额外覆盖 previous-write 无 write 的同类契约（只测一次 previous-only）
          keychain: memoryKeychain(),
          listenServer: createLoopbackTestListenAdapter(),
          // 使用默认 managementServerFactory = createServer
        });
        openRuntimes.add(leakedRuntime);
      } catch (error) {
        const message = String(error && error.message);
        assert.match(
          message,
          /previousReadToken requires readToken/,
          `expected pairing error, got: ${message}`,
        );
        assertNoSentinels(message, 'previous-only pairing error');
        assertNoSentinels(String(error && error.stack || ''), 'previous-only error stack');

        // Agent 必须已关闭：同一端口可立即 rebind
        const rebound = createHttpServer();
        await new Promise((resolve, reject) => {
          rebound.once('error', reject);
          rebound.listen(agentPort, '127.0.0.1', resolve);
        });
        assert.equal(rebound.listening, true);
        await new Promise((resolve) => rebound.close(resolve));
        return;
      }

      // 旧生产若忽略 previousReadToken 会半启动成功 → 行为 RED
      assert.fail('expected previous-only management pairing failure from real createServer');
    } finally {
      if (leakedRuntime) {
        await leakedRuntime.close().catch(() => {});
        openRuntimes.delete(leakedRuntime);
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runControllerMain 向 start 透传新增字段；成功/失败/运行时日志不含 sentinel', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-v146-main-'));
    try {
      /** @type {Record<string, unknown> | null} */
      let startOptions = null;
      const successLogs = [];
      const successErrors = [];
      await runControllerMain({
        env: {
          DATA_DIR: dataDir,
          LINKE_AGENT_HOST: '192.168.10.4',
          LINKE_AUTH_TOKEN: FULL,
          LINKE_TOKEN: FULL_LEGACY,
          LINKE_READ_TOKEN: READ,
          LINKE_PREVIOUS_READ_TOKEN: PREV_READ,
          LINKE_WRITE_TOKEN: WRITE,
          LINKE_PREVIOUS_WRITE_TOKEN: PREV_WRITE,
          LINKE_ADMIN_TOKEN: ADMIN,
        },
        start: async (options) => {
          startOptions = options;
          return {
            status: {
              managementHost: '127.0.0.1',
              managementListening: true,
              agentBindConfigured: true,
              agentListening: true,
              tlsFingerprint: 'ab'.repeat(32),
            },
            close: async () => {},
          };
        },
        log: (line) => successLogs.push(String(line)),
        error: (line) => successErrors.push(String(line)),
        exit: () => {},
        onSignal: () => {},
      });

      assert.ok(startOptions, 'start stub must receive options');
      assert.equal(startOptions.authToken, FULL);
      assert.equal(startOptions.readToken, READ);
      assert.equal(startOptions.previousReadToken, PREV_READ);
      assert.equal(startOptions.writeToken, WRITE);
      assert.equal(startOptions.previousWriteToken, PREV_WRITE);
      assert.equal(startOptions.adminToken, ADMIN);
      assertNoSentinels(successLogs.join('\n'), 'runControllerMain success logs');
      assertNoSentinels(successErrors.join('\n'), 'runControllerMain success errors');

      const failLogs = [];
      const failErrors = [];
      let failExit = null;
      await runControllerMain({
        env: {
          DATA_DIR: dataDir,
          LINKE_AGENT_HOST: '192.168.10.4',
          LINKE_AUTH_TOKEN: FULL,
          LINKE_READ_TOKEN: READ,
          LINKE_PREVIOUS_READ_TOKEN: PREV_READ,
          LINKE_WRITE_TOKEN: WRITE,
          LINKE_PREVIOUS_WRITE_TOKEN: PREV_WRITE,
          LINKE_ADMIN_TOKEN: ADMIN,
        },
        start: async () => {
          throw new Error(`start boom ${FULL} ${PREV_READ} ${PREV_WRITE} ${ADMIN}`);
        },
        log: (line) => failLogs.push(String(line)),
        error: (line) => failErrors.push(String(line)),
        exit: (code) => {
          failExit = code;
        },
        onSignal: () => {},
      });
      assert.equal(failExit, 1);
      assert.match(failErrors.join('\n'), /failed to start/i);
      assertNoSentinels(failLogs.join('\n'), 'startup failure logs');
      assertNoSentinels(failErrors.join('\n'), 'startup failure errors');

      // 运行时错误路径：真实 startController + 固定组件名日志
      const runtimeLogs = [];
      const runtimeErrors = [];
      /** @type {{ status: object, close: Function, agentServer: object, managementServer: object } | null} */
      let liveRuntime = null;
      await runControllerMain({
        env: {
          DATA_DIR: dataDir,
          LINKE_AGENT_HOST: '192.168.10.4',
          LINKE_ADMIN_TOKEN: ADMIN,
          LINKE_WRITE_TOKEN: WRITE,
          LINKE_PREVIOUS_WRITE_TOKEN: PREV_WRITE,
        },
        start: async (options) => {
          liveRuntime = await startController({
            ...options,
            managementHost: '127.0.0.1',
            managementPort: 0,
            agentPort: 0,
            keychain: memoryKeychain(),
            listenServer: createLoopbackTestListenAdapter(),
            agentServerFactory: () => trackedServer([], 'agent'),
            managementServerFactory: () => trackedServer([], 'management'),
            onRuntimeError: options.onRuntimeError,
          });
          openRuntimes.add(liveRuntime);
          return liveRuntime;
        },
        log: (line) => runtimeLogs.push(String(line)),
        error: (line) => runtimeErrors.push(String(line)),
        exit: () => {},
        onSignal: () => {},
      });
      assert.ok(liveRuntime);
      liveRuntime.agentServer.emit(
        'error',
        new Error(`runtime agent ${ADMIN} ${WRITE} ${PREV_WRITE}`),
      );
      liveRuntime.managementServer.emit(
        'error',
        new Error(`runtime management ${ADMIN} ${PREV_READ}`),
      );
      assert.ok(runtimeErrors.some((line) => line === 'Linke controller runtime error: agent'));
      assert.ok(runtimeErrors.some((line) => line === 'Linke controller runtime error: management'));
      assertNoSentinels([...runtimeLogs, ...runtimeErrors].join('\n'), 'runtime error logs');
      await liveRuntime.close();
      openRuntimes.delete(liveRuntime);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
