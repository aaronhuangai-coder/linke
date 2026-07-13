import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { ERROR_CODES } from '../src/error-codes.js';

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
