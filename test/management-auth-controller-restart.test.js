/**
 * 管理认证 controller 显式重启：只使用内存 Keychain 与注入 effects，绝不执行真实 launchctl/HTTP。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ManagementAuthControllerRestartError,
  restartManagementAuthController,
  restartManagementAuthControllerForTest,
} from '../src/management-auth-controller-restart.js';
import { MANAGEMENT_AUTH_SCOPE_MAP } from '../src/management-auth-keychain.js';
import { stageManagementAuthKeychainRotation } from '../src/management-auth-rotation.js';

const TOKEN = `restart-token_${'R'.repeat(30)}`;
const OLD_TOKEN = `restart-old_${'O'.repeat(32)}`;
const PORT = 3000;
const UID = 501;
const INVALID = 'management-auth-controller-restart-invalid';
const UNAVAILABLE = 'management-auth-controller-restart-unavailable';
const AUTH_FAILED = 'management-auth-controller-restart-authentication-failed';

function itemIds(scope) {
  const current = MANAGEMENT_AUTH_SCOPE_MAP.find((entry) => entry.scope === scope);
  const previous = MANAGEMENT_AUTH_SCOPE_MAP.find((entry) => entry.requires === scope);
  if (!current || !previous) throw new Error('test scope mapping incomplete');
  return { currentId: current.itemId, previousId: previous.itemId };
}

async function genuineReceipt(scope = 'read', alreadyStaged = false) {
  const { currentId, previousId } = itemIds(scope);
  const backing = new Map();
  if (alreadyStaged) {
    backing.set(currentId, TOKEN);
    backing.set(previousId, OLD_TOKEN);
  } else {
    backing.set(currentId, OLD_TOKEN);
  }
  const keychain = {
    async get(itemId) {
      if (!backing.has(itemId)) {
        const error = new Error('missing');
        error.code = 'keychain-item-missing';
        throw error;
      }
      return backing.get(itemId);
    },
    async set(itemId, value) {
      backing.set(itemId, value);
    },
  };
  return stageManagementAuthKeychainRotation({
    keychain,
    scope,
    newToken: TOKEN,
    withExclusiveLock: async (task) => task(),
  });
}

function healthyAuthBody(scope) {
  return Buffer.from(JSON.stringify({
    status: 'ok',
    service: 'linke',
    auth: {
      enabled: true,
      configuredScopes: {
        full: false,
        read: scope === 'read',
        write: scope === 'write',
        admin: false,
      },
      previousTokenOverlapConfigured: {
        read: scope === 'read',
        write: scope === 'write',
      },
    },
    startupCredentialSource: {
      mode: 'keychain',
      startupSnapshot: true,
      hotReload: false,
      selfReported: true,
      attested: false,
    },
    safety: { tokenValuesReturned: false, successAuditEvent: false },
  }));
}

function createEffects({
  uid = UID,
  execImpl,
  requestImpl,
  nowValues,
  waitImpl,
} = {}) {
  const events = [];
  const execCalls = [];
  const requests = [];
  let nowIndex = 0;
  const clock = nowValues ?? [1_000, 1_001, 1_002];
  const effects = {
    getUid() {
      events.push('getUid');
      return typeof uid === 'function' ? uid() : uid;
    },
    async execFile(file, argv, options) {
      events.push('execFile');
      execCalls.push({ file, argv: [...argv], options: { ...options } });
      if (execImpl) return execImpl(file, argv, options);
      return { stdout: '', stderr: '' };
    },
    async request(url, options) {
      events.push('request');
      requests.push({
        url,
        options: {
          ...options,
          headers: options?.headers ? { ...options.headers } : options?.headers,
        },
      });
      if (requestImpl) return requestImpl(url, options, requests.length);
      return { statusCode: 200, body: healthyAuthBody('read') };
    },
    now() {
      events.push('now');
      const value = clock[Math.min(nowIndex, clock.length - 1)];
      nowIndex += 1;
      return value;
    },
    async wait(delayMs) {
      events.push(`wait:${delayMs}`);
      if (waitImpl) return waitImpl(delayMs);
      return undefined;
    },
  };
  return { effects, events, execCalls, requests };
}

function input(receipt, overrides = {}) {
  return {
    rotationReceipt: receipt,
    newToken: TOKEN,
    controllerPort: PORT,
    ...overrides,
  };
}

function assertFixedError(error, code, forbidden = []) {
  assert.ok(error instanceof ManagementAuthControllerRestartError);
  assert.equal(error.name, 'ManagementAuthControllerRestartError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  const text = `${error.name}\n${error.code}\n${error.message}\n${error.stack}`;
  for (const value of forbidden) assert.equal(text.includes(value), false);
  return true;
}

describe('management-auth controller restart success contract', () => {
  for (const scope of ['read', 'write']) {
    it(`scope=${scope}: 固定 kickstart controller，随后用新 token 验证 Keychain startup snapshot`, async () => {
      const receipt = await genuineReceipt(scope);
      const world = createEffects({
        requestImpl: async () => ({ statusCode: 200, body: healthyAuthBody(scope) }),
      });
      const result = await restartManagementAuthControllerForTest(input(receipt), world.effects);

      assert.deepEqual(world.execCalls, [{
        file: '/bin/launchctl',
        argv: ['kickstart', '-k', `gui/${UID}/com.linke.controller`],
        options: {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          shell: false,
          encoding: 'utf8',
        },
      }]);
      assert.equal(world.requests.length, 1);
      assert.equal(world.requests[0].url, `http://127.0.0.1:${PORT}/api/auth-status`);
      assert.deepEqual(world.requests[0].options, {
        timeout: 5_000,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.deepEqual(result, {
        state: 'restarted',
        scope,
        previousOverlapConfigured: true,
        controllerRestarted: true,
        authenticationVerified: true,
        restartRequired: false,
        hotReload: false,
        automaticRestart: false,
        sensitiveValuesReturned: false,
        alreadyStaged: false,
      });
      assert.equal(Object.isFrozen(result), true);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
      assert.ok(world.events.indexOf('execFile') < world.events.indexOf('request'));
    });
  }

  it('alreadyStaged 重试 receipt 可完成重启并保留脱敏事实', async () => {
    const receipt = await genuineReceipt('read', true);
    const world = createEffects();
    const result = await restartManagementAuthControllerForTest(input(receipt), world.effects);
    assert.equal(result.alreadyStaged, true);
  });
});

describe('management-auth controller restart consume-before-mutation', () => {
  it('输入与依赖非法均在 authority 消费前失败，修正后同 receipt 可成功', async () => {
    const invalidCases = [
      (receipt) => ({ value: null, deps: createEffects().effects }),
      (receipt) => ({ value: { ...input(receipt), extra: true }, deps: createEffects().effects }),
      (receipt) => ({ value: input(receipt, { controllerPort: 0 }), deps: createEffects().effects }),
      (receipt) => ({ value: input(receipt, { controllerPort: 65536 }), deps: createEffects().effects }),
      (receipt) => ({ value: input(receipt, { newToken: 'short' }), deps: createEffects().effects }),
      (receipt) => ({ value: input(receipt), deps: { ...createEffects().effects, extra: () => {} } }),
      (receipt) => ({ value: input(receipt), deps: { ...createEffects().effects, request: null } }),
      (receipt) => ({ value: input(receipt), deps: createEffects({ uid: -1 }).effects }),
    ];

    for (const makeCase of invalidCases) {
      const receipt = await genuineReceipt('read');
      const candidate = makeCase(receipt);
      await assert.rejects(
        restartManagementAuthControllerForTest(candidate.value, candidate.deps),
        (error) => assertFixedError(error, INVALID, [TOKEN]),
      );
      const world = createEffects();
      const result = await restartManagementAuthControllerForTest(input(receipt), world.effects);
      assert.equal(result.authenticationVerified, true);
    }
  });

  it('clone/lookalike/Proxy receipt 均拒绝且不执行 launchctl/HTTP', async () => {
    const receipt = await genuineReceipt('read');
    let traps = 0;
    const hostile = new Proxy(receipt, {
      get() { traps += 1; throw new Error('must-not-read'); },
      ownKeys() { traps += 1; throw new Error('must-not-enumerate'); },
    });
    for (const candidate of [structuredClone(receipt), { ...receipt }, hostile]) {
      const world = createEffects();
      await assert.rejects(
        restartManagementAuthControllerForTest(input(candidate), world.effects),
        (error) => assertFixedError(error, UNAVAILABLE, [TOKEN]),
      );
      assert.deepEqual(world.execCalls, []);
      assert.deepEqual(world.requests, []);
    }
    assert.equal(traps, 0);
    const world = createEffects();
    assert.equal(
      (await restartManagementAuthControllerForTest(input(receipt), world.effects)).state,
      'restarted',
    );
  });
});

describe('management-auth controller restart post-consume failure and auth proof', () => {
  it('launchctl 失败固定 unavailable，authority 已烧毁；同 receipt 不可重放', async () => {
    const receipt = await genuineReceipt('read');
    const raw = new Error(`launchctl raw ${TOKEN}`);
    const failed = createEffects({ execImpl: async () => { throw raw; } });
    await assert.rejects(
      restartManagementAuthControllerForTest(input(receipt), failed.effects),
      (error) => assertFixedError(error, UNAVAILABLE, [TOKEN, raw.message]),
    );
    assert.deepEqual(failed.requests, []);

    const retry = createEffects();
    await assert.rejects(
      restartManagementAuthControllerForTest(input(receipt), retry.effects),
      (error) => assertFixedError(error, UNAVAILABLE, [TOKEN]),
    );
    assert.deepEqual(retry.execCalls, []);
  });

  it('401/旧 schema/degraded/无 overlap 会重试，随后真实 proof 成功', async () => {
    const receipt = await genuineReceipt('write');
    const bodies = [
      { statusCode: 401, body: Buffer.from('{"error":"Unauthorized"}') },
      { statusCode: 200, body: Buffer.from('{"ready":true}') },
      {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({
          status: 'ok', service: 'linke',
          auth: {
            enabled: true,
            configuredScopes: { write: true },
            previousTokenOverlapConfigured: { write: false },
          },
          startupCredentialSource: { mode: 'keychain', startupSnapshot: true, hotReload: false },
        })),
      },
      { statusCode: 200, body: healthyAuthBody('write') },
    ];
    const world = createEffects({
      nowValues: [1_000, 1_001, 1_002, 1_003, 1_004, 1_005],
      requestImpl: async (_url, _options, call) => bodies[call - 1],
    });
    const result = await restartManagementAuthControllerForTest(input(receipt), world.effects);
    assert.equal(result.authenticationVerified, true);
    assert.equal(world.requests.length, 4);
    assert.equal(world.events.filter((event) => event === 'wait:250').length, 3);
  });

  it('证明窗口耗尽固定 authentication-failed，绝不回显 token/body/raw error', async () => {
    const receipt = await genuineReceipt('read');
    const canary = `body-canary-${TOKEN}`;
    const world = createEffects({
      nowValues: [0, 10_000, 20_000, 30_000],
      requestImpl: async () => ({ statusCode: 503, body: Buffer.from(canary) }),
    });
    await assert.rejects(
      restartManagementAuthControllerForTest(input(receipt), world.effects),
      (error) => assertFixedError(error, AUTH_FAILED, [TOKEN, canary]),
    );
    assert.ok(world.requests.length >= 1);
  });

  it('超大/畸形 JSON 与错误 startup source 均不能形成 proof', async () => {
    for (const response of [
      { statusCode: 200, body: Buffer.alloc(64 * 1024 + 1, 0x20) },
      { statusCode: 200, body: Buffer.from('{not-json') },
      {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({
          status: 'ok', service: 'linke',
          auth: {
            enabled: true,
            configuredScopes: { read: true },
            previousTokenOverlapConfigured: { read: true },
          },
          startupCredentialSource: { mode: 'direct', startupSnapshot: true, hotReload: false },
        })),
      },
    ]) {
      const receipt = await genuineReceipt('read');
      const world = createEffects({
        nowValues: [0, 30_000],
        requestImpl: async () => response,
      });
      await assert.rejects(
        restartManagementAuthControllerForTest(input(receipt), world.effects),
        (error) => assertFixedError(error, AUTH_FAILED, [TOKEN]),
      );
    }
  });
});

describe('management-auth controller restart production boundary', () => {
  it('production 入口不接受依赖参数；import 不执行 launchctl 或 HTTP', () => {
    assert.equal(restartManagementAuthController.length, 1);
    assert.equal(restartManagementAuthControllerForTest.length, 2);
    assert.equal(typeof restartManagementAuthController, 'function');
  });
});
