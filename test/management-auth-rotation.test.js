/**
 * V1.46 管理认证 Keychain 轮换 staging — 行为矩阵。
 *
 * 冻结设计：stageManagementAuthKeychainRotation({keychain,scope,newToken,withExclusiveLock})
 * 覆盖前置校验、成功 staging 精确 I/O 顺序、读取/写入/复读分类、同值分类、
 * constant-time 分支、锁 exact-once/防篡改 guard、crash window 重试与并发串行证据。
 *
 * 边界：全部 token 均为合成 sentinel；只用内存 fake Keychain/锁，不接真实 Keychain、
 * 不走 CLI、不自动重启；并发用例仅以单进程 fake 排他队列取证，不声称 production
 * 多进程语义。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAndConsumeManagementAuthRestartAuthority,
  ManagementAuthRotationError,
  stageManagementAuthKeychainRotation,
  validateManagementAuthRotationToken,
} from '../src/management-auth-rotation.js';
import { MANAGEMENT_AUTH_SCOPE_MAP } from '../src/management-auth-keychain.js';

const FIXED_INVALID = 'management-auth-rotation-invalid';
const FIXED_UNAVAILABLE = 'management-auth-rotation-unavailable';
const FIXED_RECOVERY = 'management-auth-rotation-recovery-required';
const FIXED_CODES = new Set([FIXED_INVALID, FIXED_UNAVAILABLE, FIXED_RECOVERY]);

// 合成 sentinel token：base64url 合法、43 字符、彼此可区分，仅用于断言映射/分支/防泄漏。
const NEW_TOKEN = `new-rotation-token_${'N'.repeat(24)}`;
const OLD_TOKEN = `old-rotation-token_${'O'.repeat(24)}`;
const PREV_TOKEN = `prv-rotation-token_${'P'.repeat(24)}`;
const OTHER_TOKEN = `oth-rotation-token_${'Q'.repeat(24)}`;

const ALL_SECRET_STRINGS = [
  NEW_TOKEN,
  OLD_TOKEN,
  PREV_TOKEN,
  OTHER_TOKEN,
  'management-auth.read',
  'management-auth.read.previous',
  'management-auth.write',
  'management-auth.write.previous',
];

/** 从既有固定映射表派生 scope 的 current/previous itemId（映射必须来自 MANAGEMENT_AUTH_SCOPE_MAP）。 */
function rotationItemIds(scope) {
  const current = MANAGEMENT_AUTH_SCOPE_MAP.find((def) => def.scope === scope && def.current === true);
  const previous = MANAGEMENT_AUTH_SCOPE_MAP.find(
    (def) => def.current === false && def.requires === scope,
  );
  if (!current || !previous) throw new Error(`scope map incomplete for rotation scope ${scope}`);
  return { currentId: current.itemId, previousId: previous.itemId };
}

/** 与生产 KeychainStore 一致的 missing 错误形状（code=keychain-item-missing）。 */
function keychainMissingError() {
  const error = new Error('keychain-item-missing');
  error.code = 'keychain-item-missing';
  return error;
}

/**
 * 记录型内存 Keychain + 记录型排他锁。
 * - events 按时间顺序记录 lock-acquire/lock-release/get/set/delete，get/set 记录 lockHeld；
 * - onGet/onSet 钩子在任何默认行为之前执行，可 throw 注入失败或改写 backing；
 * - applySets=false 时 set 不落 backing（模拟静默不持久）；
 * - delete 为越界能力探针：实现绝不允许调用（no delete/no rollback）。
 */
function createWorld({ backing = new Map(), onGet = null, onSet = null, applySets = true } = {}) {
  const events = [];
  const lock = { calls: 0, held: false };
  const keychain = {
    async get(itemId) {
      events.push({ op: 'get', itemId, lockHeld: lock.held });
      if (onGet) await onGet(itemId, backing);
      if (!backing.has(itemId)) throw keychainMissingError();
      return backing.get(itemId);
    },
    async set(itemId, value) {
      events.push({ op: 'set', itemId, value, lockHeld: lock.held });
      if (onSet) await onSet(itemId, value, backing);
      if (applySets) backing.set(itemId, value);
    },
    async delete(itemId) {
      events.push({ op: 'delete', itemId, lockHeld: lock.held });
      throw keychainMissingError();
    },
  };
  const withExclusiveLock = async (task) => {
    lock.calls += 1;
    events.push({ op: 'lock-acquire', lockHeld: false });
    lock.held = true;
    try {
      return await task();
    } finally {
      lock.held = false;
      events.push({ op: 'lock-release', lockHeld: false });
    }
  };
  return { events, lock, keychain, withExclusiveLock, backing };
}

/** 合法输入基底（scope=newToken 可被 overrides 覆盖为非法值）。 */
function validInput(world, overrides = {}) {
  return {
    keychain: world.keychain,
    scope: 'write',
    newToken: NEW_TOKEN,
    withExclusiveLock: world.withExclusiveLock,
    ...overrides,
  };
}

/** 固定成功 receipt（仅 alreadyStaged 可变）。 */
function expectedReceipt(scope, alreadyStaged) {
  return {
    state: 'staged',
    scope,
    previousOverlapConfigured: true,
    restartRequired: true,
    hotReload: false,
    automaticRestart: false,
    sensitiveValuesReturned: false,
    alreadyStaged,
  };
}

function assertNoSecrets(blob, secrets) {
  const text = String(blob);
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, 'must not echo synthetic secret/itemId/scope material');
  }
}

/** 固定错误：精确 code、message===code、固定 name、无敏感回显。 */
function assertFixedError(error, code, secrets = []) {
  assert.ok(error instanceof ManagementAuthRotationError, 'must be ManagementAuthRotationError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.name, 'ManagementAuthRotationError');
  assertNoSecrets(`${error.name}\n${error.code}\n${error.message}\n${error.stack}`, secrets);
}

/** 固定错误信封（冻结设计未钉死具体 code 的失败面）：code ∈ 固定集合、不回显。 */
function assertFixedErrorEnvelope(error, secrets = []) {
  assert.ok(error instanceof ManagementAuthRotationError, 'must be ManagementAuthRotationError');
  assert.ok(FIXED_CODES.has(error.code), `code must be one of the fixed set, got ${error.code}`);
  assert.equal(error.message, error.code);
  assert.equal(error.name, 'ManagementAuthRotationError');
  assertNoSecrets(`${error.name}\n${error.code}\n${error.message}\n${error.stack}`, secrets);
}

/** receipt：精确键集/取值、冻结、不含任何 token/itemId 材料（scope 为设计内明文）。 */
function assertExactReceipt(receipt, scope, alreadyStaged, secrets = ALL_SECRET_STRINGS) {
  assert.deepEqual(receipt, expectedReceipt(scope, alreadyStaged));
  assert.equal(Object.isFrozen(receipt), true, 'receipt must be frozen');
  assertNoSecrets(JSON.stringify(receipt), secrets);
}

/** I/O 时间线投影：lock 事件 + get:/set: itemId。 */
function ioTrace(events) {
  return events.map((event) => (
    event.op.startsWith('lock') ? event.op : `${event.op}:${event.itemId}`
  ));
}

function setCalls(events) {
  return events.filter((event) => event.op === 'set').map((event) => [event.itemId, event.value]);
}

/** 所有 Keychain I/O 必须发生在锁内；锁恰好 acquire/release 一次且包住全部 I/O。 */
function assertAllKeychainIoInsideLock(events) {
  const io = events.filter((event) => event.op === 'get' || event.op === 'set' || event.op === 'delete');
  assert.ok(io.length > 0, 'expected keychain I/O on this path');
  for (const event of io) {
    assert.equal(event.lockHeld, true, `${event.op} ${event.itemId} must occur inside withExclusiveLock`);
  }
  assert.equal(events[0].op, 'lock-acquire', 'lock must be acquired before any I/O');
  assert.equal(events[events.length - 1].op, 'lock-release', 'lock must be released after all I/O');
  assert.equal(events.filter((event) => event.op === 'lock-acquire').length, 1);
  assert.equal(events.filter((event) => event.op === 'lock-release').length, 1);
}

/** 前置校验失败路径：零锁调用、零 Keychain 事件。 */
function assertZeroIo(world) {
  assert.deepEqual(world.events, []);
  assert.equal(world.lock.calls, 0);
}

function assertNoDelete(world) {
  assert.deepEqual(world.events.filter((event) => event.op === 'delete'), [], 'no delete allowed');
}

describe('management-auth-rotation 前置校验（fixed invalid，零 lock/零 I/O，无回显）', () => {
  it('非 plain object 输入固定 invalid', async () => {
    for (const input of [undefined, null, 42, 'input', true, [], () => {}]) {
      await assert.rejects(
        stageManagementAuthKeychainRotation(input),
        (error) => { assertFixedError(error, FIXED_INVALID, ALL_SECRET_STRINGS); return true; },
        `input ${Object.prototype.toString.call(input)} must reject with fixed invalid`,
      );
    }
  });

  it('keychain/withExclusiveLock 形状非法：fixed invalid，零锁调用零 Keychain I/O', async () => {
    const malformed = [
      { keychain: undefined },
      { keychain: null },
      { keychain: 'keychain' },
      { keychain: {} },
      { keychain: { get: async () => OLD_TOKEN } },
      { keychain: { set: async () => {} } },
      { keychain: { get: 1, set: async () => {} } },
      { keychain: { get: async () => OLD_TOKEN, set: null } },
      { withExclusiveLock: undefined },
      { withExclusiveLock: null },
      { withExclusiveLock: 'lock' },
      { withExclusiveLock: {} },
    ];
    for (const overrides of malformed) {
      const world = createWorld();
      await assert.rejects(
        stageManagementAuthKeychainRotation(validInput(world, overrides)),
        (error) => { assertFixedError(error, FIXED_INVALID, ALL_SECRET_STRINGS); return true; },
        `must reject overrides ${JSON.stringify(Object.keys(overrides))}`,
      );
      assertZeroIo(world);
    }
  });

  it('输入字段 getter 抛带 sentinel 的原始错误 → 转换固定 invalid，不回显，零锁零 I/O', async () => {
    const world = createWorld();
    const sentinel = 'synthetic-getter-boom-sentinel';
    const input = {
      keychain: world.keychain,
      newToken: NEW_TOKEN,
      withExclusiveLock: world.withExclusiveLock,
    };
    Object.defineProperty(input, 'scope', {
      enumerable: true,
      get() { throw new Error(`synthetic getter boom ${sentinel}`); },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(input),
      (error) => { assertFixedError(error, FIXED_INVALID, [...ALL_SECRET_STRINGS, sentinel]); return true; },
    );
    assertZeroIo(world);
  });

  it('scope 只接受精确 read/write：其它取值 fixed invalid 且不回显原值', async () => {
    const cases = [
      'full', 'admin', 'previous-read', 'previous-write',
      'READ', 'WRITE', 'Read', 'read ', ' read', '',
      null, 42, undefined, ['write'],
    ];
    for (const scope of cases) {
      const world = createWorld();
      const echoed = typeof scope === 'string' && scope.length > 0 ? [scope] : [];
      await assert.rejects(
        stageManagementAuthKeychainRotation(validInput(world, { scope })),
        (error) => { assertFixedError(error, FIXED_INVALID, [...ALL_SECRET_STRINGS, ...echoed]); return true; },
        `scope ${JSON.stringify(scope)} must reject`,
      );
      assertZeroIo(world);
    }
  });

  it('newToken 必须 base64url 且 43..128：非法值 fixed invalid、零 I/O、不回显', async () => {
    const cases = [
      undefined, null, 42, '', '   ',
      'S'.repeat(42),
      'L'.repeat(129),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(20)} ${'A'.repeat(22)}`,
      `${'A'.repeat(42)}.`,
      `${'A'.repeat(42)}\n`,
      `${NEW_TOKEN}!`,
    ];
    for (const newToken of cases) {
      const world = createWorld();
      await assert.rejects(
        stageManagementAuthKeychainRotation(validInput(world, { newToken })),
        (error) => { assertFixedError(error, FIXED_INVALID, ALL_SECRET_STRINGS); return true; },
        `newToken ${JSON.stringify(typeof newToken === 'string' ? newToken.slice(0, 8) : newToken)} must reject`,
      );
      assertZeroIo(world);
    }
  });

  it('43/128 边界与 base64url 全字符集通过前置校验（进入读取分类而非 invalid）', async () => {
    for (const newToken of ['A'.repeat(43), 'B'.repeat(128), `${'Ab09-_'.repeat(7)}Q`]) {
      // backing 为空：current missing → unavailable；若仍 invalid 说明前置校验误杀合法 token。
      const world = createWorld();
      await assert.rejects(
        stageManagementAuthKeychainRotation(validInput(world, { newToken })),
        (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [newToken, ...ALL_SECRET_STRINGS]); return true; },
        `boundary newToken (length ${newToken.length}) must reach read classification`,
      );
      assert.deepEqual(setCalls(world.events), []);
    }
  });
});

describe('management-auth-rotation 成功 staging（read/write × previous absent/present）', () => {
  for (const scope of ['read', 'write']) {
    for (const previousPresent of [false, true]) {
      it(`scope=${scope} previous ${previousPresent ? 'present' : 'absent'}：精确 I/O 顺序且全部在锁内`, async () => {
        const { currentId, previousId } = rotationItemIds(scope);
        const backing = new Map([[currentId, OLD_TOKEN]]);
        if (previousPresent) backing.set(previousId, PREV_TOKEN);
        const world = createWorld({ backing });

        const receipt = await stageManagementAuthKeychainRotation(validInput(world, { scope }));

        assertExactReceipt(receipt, scope, false);
        // 冻结顺序：get current → get previous → set previous=current → set current=new → get previous → get current
        assert.deepEqual(ioTrace(world.events), [
          'lock-acquire',
          `get:${currentId}`,
          `get:${previousId}`,
          `set:${previousId}`,
          `set:${currentId}`,
          `get:${previousId}`,
          `get:${currentId}`,
          'lock-release',
        ]);
        assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
        assertAllKeychainIoInsideLock(world.events);
        assert.equal(world.lock.calls, 1, 'withExclusiveLock must be called exactly once');
        assert.equal(world.backing.get(currentId), NEW_TOKEN);
        assert.equal(world.backing.get(previousId), OLD_TOKEN);
      });
    }
  }

  it('receipt 精确键集、冻结、不含任何 token/itemId 材料', async () => {
    const { currentId, previousId } = rotationItemIds('write');
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN], [previousId, PREV_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', false);
    assert.deepEqual(
      Object.keys(receipt).sort(),
      [
        'alreadyStaged',
        'automaticRestart',
        'hotReload',
        'previousOverlapConfigured',
        'restartRequired',
        'scope',
        'sensitiveValuesReturned',
        'state',
      ].sort(),
    );
  });
});

describe('management-auth-rotation restart authority 对象身份与一次性消费', () => {
  it('真实 staging receipt 可消费一次，返回冻结脱敏 authority；重放拒绝', async () => {
    const { currentId } = rotationItemIds('read');
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world, { scope: 'read' }));

    const authority = assertAndConsumeManagementAuthRestartAuthority(receipt);
    assert.deepEqual(authority, { scope: 'read', alreadyStaged: false });
    assert.equal(Object.isFrozen(authority), true);
    assertNoSecrets(JSON.stringify(authority), ALL_SECRET_STRINGS);
    assert.throws(
      () => assertAndConsumeManagementAuthRestartAuthority(receipt),
      (error) => {
        assertFixedError(error, FIXED_UNAVAILABLE, ALL_SECRET_STRINGS);
        return true;
      },
    );
  });

  it('alreadyStaged receipt authority 保留脱敏重试事实', async () => {
    const { currentId, previousId } = rotationItemIds('write');
    const world = createWorld({
      backing: new Map([[currentId, NEW_TOKEN], [previousId, OLD_TOKEN]]),
    });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assert.deepEqual(
      assertAndConsumeManagementAuthRestartAuthority(receipt),
      { scope: 'write', alreadyStaged: true },
    );
  });

  it('clone/lookalike/Proxy/primitive 均拒绝，Proxy getter/trap 不触发', async () => {
    const { currentId } = rotationItemIds('write');
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    let traps = 0;
    const hostile = new Proxy(receipt, {
      get() { traps += 1; throw new Error('must-not-read'); },
      getPrototypeOf() { traps += 1; throw new Error('must-not-probe'); },
      ownKeys() { traps += 1; throw new Error('must-not-enumerate'); },
    });
    for (const candidate of [
      structuredClone(receipt),
      { ...receipt },
      hostile,
      null,
      'receipt',
      1,
    ]) {
      assert.throws(
        () => assertAndConsumeManagementAuthRestartAuthority(candidate),
        (error) => {
          assertFixedError(error, FIXED_UNAVAILABLE, ALL_SECRET_STRINGS);
          return true;
        },
      );
    }
    assert.equal(traps, 0);
    // 伪品拒绝不得烧毁真实 receipt。
    assert.deepEqual(
      assertAndConsumeManagementAuthRestartAuthority(receipt),
      { scope: 'write', alreadyStaged: false },
    );
  });
});

describe('management-auth-rotation 读取阶段分类（零写，读取在锁内）', () => {
  const { currentId, previousId } = rotationItemIds('write');

  it('current 抛 code=keychain-item-missing → unavailable，零写', async () => {
    const world = createWorld({ backing: new Map() });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, 'write']); return true; },
    );
    assert.deepEqual(ioTrace(world.events), ['lock-acquire', `get:${currentId}`, 'lock-release']);
    assertAllKeychainIoInsideLock(world.events);
    assertNoDelete(world);
  });

  it('current 抛 keychain-unavailable → unavailable，无底层回显', async () => {
    const boom = new Error('synthetic keychain backend down');
    boom.code = 'keychain-unavailable';
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]), onGet: () => { throw boom; } });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });

  it('current 抛任意原始错误 → unavailable，错误不含底层 message/token', async () => {
    const boom = new Error(`synthetic boom while reading ${OLD_TOKEN}`);
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]), onGet: () => { throw boom; } });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
  });

  it('current 抛非 Error 值 → unavailable', async () => {
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: () => { throw 'synthetic string failure'; }, // eslint-disable-line no-throw-literal
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
  });

  it('current 返回非字符串/空白 → unavailable，零写', async () => {
    for (const bad of [42, null, undefined, false, '', '   ']) {
      const world = createWorld({ backing: new Map([[currentId, bad]]) });
      await assert.rejects(
        stageManagementAuthKeychainRotation(validInput(world)),
        (error) => { assertFixedError(error, FIXED_UNAVAILABLE, ALL_SECRET_STRINGS); return true; },
        `current=${JSON.stringify(bad)} must be unavailable`,
      );
      assert.deepEqual(setCalls(world.events), []);
      assertNoDelete(world);
    }
  });

  it('previous 抛 keychain-unavailable → unavailable，零写', async () => {
    const boom = new Error('synthetic previous read down');
    boom.code = 'keychain-unavailable';
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId) => { if (itemId === previousId) throw boom; },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(ioTrace(world.events), [
      'lock-acquire', `get:${currentId}`, `get:${previousId}`, 'lock-release',
    ]);
    assert.deepEqual(setCalls(world.events), []);
  });

  it('previous 抛非 missing 原始错误 → unavailable，零写', async () => {
    const boom = new Error('synthetic previous raw boom');
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId) => { if (itemId === previousId) throw boom; },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
  });

  it('previous 初读错误对象的 code getter 自身抛错 → 固定 unavailable，不回显，零写', async () => {
    const sentinel = 'synthetic-code-getter-sentinel';
    const weird = {};
    Object.defineProperty(weird, 'code', {
      enumerable: true,
      get() { throw new Error(`synthetic code getter boom ${sentinel}`); },
    });
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId) => { if (itemId === previousId) throw weird; },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, sentinel]); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });

  it('previous 正常返回非字符串/空白 → recovery-required，零写', async () => {
    for (const bad of ['', '   ', 42, null]) {
      const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN], [previousId, bad]]) });
      await assert.rejects(
        stageManagementAuthKeychainRotation(validInput(world)),
        (error) => { assertFixedError(error, FIXED_RECOVERY, ALL_SECRET_STRINGS); return true; },
        `previous=${JSON.stringify(bad)} must be recovery-required`,
      );
      assert.deepEqual(setCalls(world.events), []);
      assertNoDelete(world);
    }
  });
});

describe('management-auth-rotation 同值分类（alreadyStaged / no-anchor / same-previous）', () => {
  const { currentId, previousId } = rotationItemIds('write');

  it('new==current 且 previous 存在且 !=current → alreadyStaged:true，零写，不再复读', async () => {
    const world = createWorld({ backing: new Map([[currentId, NEW_TOKEN], [previousId, PREV_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', true);
    assert.deepEqual(ioTrace(world.events), [
      'lock-acquire', `get:${currentId}`, `get:${previousId}`, 'lock-release',
    ]);
    assert.deepEqual(setCalls(world.events), []);
    assertAllKeychainIoInsideLock(world.events);
  });

  it('new==current 且 previous missing → recovery-required，零写（无回滚锚点）', async () => {
    const world = createWorld({ backing: new Map([[currentId, NEW_TOKEN]]) });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });

  it('new==current 且 previous==current → recovery-required，零写（锚点不独立）', async () => {
    const world = createWorld({ backing: new Map([[currentId, NEW_TOKEN], [previousId, NEW_TOKEN]]) });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });

  it('new==previous（current 不同）→ invalid，零写', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN], [previousId, NEW_TOKEN]]) });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_INVALID, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(ioTrace(world.events), [
      'lock-acquire', `get:${currentId}`, `get:${previousId}`, 'lock-release',
    ]);
    assert.deepEqual(setCalls(world.events), []);
  });

  it('constant-time 分支：current 为 new 加一字符前缀超集时不误判 alreadyStaged，照常 staging', async () => {
    const world = createWorld({
      backing: new Map([[currentId, `${NEW_TOKEN}x`], [previousId, PREV_TOKEN]]),
    });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', false);
    assert.deepEqual(setCalls(world.events), [[previousId, `${NEW_TOKEN}x`], [currentId, NEW_TOKEN]]);
  });

  it('constant-time 分支：等长仅末字符不同不误判 alreadyStaged', async () => {
    const nearMiss = `${NEW_TOKEN.slice(0, -1)}M`;
    const world = createWorld({ backing: new Map([[currentId, nearMiss], [previousId, PREV_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', false);
    assert.deepEqual(setCalls(world.events), [[previousId, nearMiss], [currentId, NEW_TOKEN]]);
  });

  it('constant-time 分支：current 为 new 的真前缀（长度差）不误判 alreadyStaged', async () => {
    const prefix = NEW_TOKEN.slice(0, 20);
    const world = createWorld({ backing: new Map([[currentId, prefix], [previousId, PREV_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', false);
    assert.deepEqual(setCalls(world.events), [[previousId, prefix], [currentId, NEW_TOKEN]]);
  });
});

describe('management-auth-rotation 写入阶段错误的只读分类（no delete/no rollback）', () => {
  const { currentId, previousId } = rotationItemIds('write');

  it('set previous no-mutation throw 且 previous 原 absent → recovery-required，零额外写/零 delete', async () => {
    const boom = new Error('synthetic previous set boom');
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onSet: (itemId) => { if (itemId === previousId) throw boom; },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN]]);
    assertAllKeychainIoInsideLock(world.events);
    assertNoDelete(world);
  });

  it('set previous mutate-then-throw（写已生效却报错）→ 复读 current==old && previous==old → unavailable', async () => {
    const boom = new Error('synthetic previous set post-write boom');
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onSet: (itemId, value, backing) => {
        if (itemId === previousId) {
          backing.set(itemId, value);
          throw boom;
        }
      },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN]]);
    assertNoDelete(world);
  });

  it('set current no-mutation throw → 复读 current==old && previous==old → unavailable，无第三次写', async () => {
    const boom = new Error('synthetic current set boom');
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onSet: (itemId) => { if (itemId === currentId) throw boom; },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
    assertAllKeychainIoInsideLock(world.events);
    assertNoDelete(world);
    assert.equal(world.backing.get(currentId), OLD_TOKEN, 'no rollback/no extra mutation');
    assert.equal(world.backing.get(previousId), OLD_TOKEN);
  });

  it('set current mutate-then-throw（两写实际生效）→ 复读命中 desired → 返回 staged receipt', async () => {
    const boom = new Error('synthetic current set post-write boom');
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onSet: (itemId, value, backing) => {
        if (itemId === currentId) {
          backing.set(itemId, value);
          throw boom;
        }
      },
    });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', false);
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
    assert.equal(world.backing.get(currentId), NEW_TOKEN);
    assert.equal(world.backing.get(previousId), OLD_TOKEN);
  });

  it('set current throw 且分类复读失败 → recovery-required', async () => {
    const boom = new Error('synthetic current set boom');
    let currentGets = 0;
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId) => {
        if (itemId === currentId) {
          currentGets += 1;
          if (currentGets > 1) throw new Error('synthetic re-read boom');
        }
      },
      onSet: (itemId) => { if (itemId === currentId) throw boom; },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, [...ALL_SECRET_STRINGS, boom.message, 'synthetic re-read boom']); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
    assertNoDelete(world);
  });

  it('写入后复读 inconsistent（previous 被改成 new）→ recovery-required，无自动修复', async () => {
    let previousGets = 0;
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId, backing) => {
        if (itemId === previousId) {
          previousGets += 1;
          if (previousGets > 1) backing.set(previousId, NEW_TOKEN);
        }
      },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
    assertNoDelete(world);
  });
});

describe('management-auth-rotation 最终校验 mismatch 分类', () => {
  const { currentId, previousId } = rotationItemIds('write');

  it('current 静默不持久（复读仍是 old）且 previous==old → unavailable', async () => {
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      applySets: false,
      onSet: (itemId, value, backing) => {
        if (itemId === previousId) backing.set(itemId, value); // previous 持久、current 丢失
      },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_UNAVAILABLE, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
    assertNoDelete(world);
  });

  it('最终校验 get current 抛错 → recovery-required', async () => {
    let currentGets = 0;
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId) => {
        if (itemId === currentId) {
          currentGets += 1;
          if (currentGets > 1) throw new Error('synthetic verify read boom');
        }
      },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, [...ALL_SECRET_STRINGS, 'synthetic verify read boom']); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
  });

  it('最终校验 get previous 抛 missing → recovery-required（复读无法确认）', async () => {
    let previousGets = 0;
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      onGet: (itemId) => {
        if (itemId === previousId) {
          previousGets += 1;
          if (previousGets > 1) throw keychainMissingError();
        }
      },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
  });

  it('最终校验 current 读回未知第三值 → recovery-required', async () => {
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN]]),
      applySets: false,
      onSet: (itemId, value, backing) => {
        if (itemId === previousId) backing.set(itemId, value);
        if (itemId === currentId) backing.set(itemId, OTHER_TOKEN);
      },
    });
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world)),
      (error) => { assertFixedError(error, FIXED_RECOVERY, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
  });
});

describe('management-auth-rotation crash window 重试', () => {
  const { currentId, previousId } = rotationItemIds('write');

  it('previous=old 且 current=old（previous 已写/current 未写）→ 同 new 重试照常 staged', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN], [previousId, OLD_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', false);
    assert.deepEqual(ioTrace(world.events), [
      'lock-acquire',
      `get:${currentId}`,
      `get:${previousId}`,
      `set:${previousId}`,
      `set:${currentId}`,
      `get:${previousId}`,
      `get:${currentId}`,
      'lock-release',
    ]);
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
    assert.equal(world.backing.get(currentId), NEW_TOKEN);
    assert.equal(world.backing.get(previousId), OLD_TOKEN);
  });

  it('current=new 且 previous=old（两写均已生效）→ 重试返回 alreadyStaged:true，零写', async () => {
    const world = createWorld({ backing: new Map([[currentId, NEW_TOKEN], [previousId, OLD_TOKEN]]) });
    const receipt = await stageManagementAuthKeychainRotation(validInput(world));
    assertExactReceipt(receipt, 'write', true);
    assert.deepEqual(setCalls(world.events), []);
    assertAllKeychainIoInsideLock(world.events);
  });
});

describe('management-auth-rotation 排他锁 guard（task exact-once / 结果防篡改）', () => {
  const { currentId, previousId } = rotationItemIds('write');
  const fabricated = expectedReceipt('write', false);

  it('lock 从不调用 task 却返回伪造 receipt → 固定 fail closed，零 Keychain I/O', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async () => fabricated;
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, ALL_SECRET_STRINGS); return true; },
    );
    assert.deepEqual(world.events, []);
  });

  it('lock 重复调用 task → 固定 fail closed', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async (task) => {
      await task();
      return task();
    };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, ALL_SECRET_STRINGS); return true; },
    );
  });

  it('lock 吞掉重复 task 调用的错误并返回首次 receipt → 仍固定 fail closed，无第二次写', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async (task) => {
      const receipt = await task();
      await task().catch(() => {}); // 重复调用且吞掉其 fail-closed 错误
      return receipt;
    };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, ALL_SECRET_STRINGS); return true; },
    );
    // 重复调用必须在自身任何 I/O 前失败：写集合仍恰好是一次 staging 的两写
    assert.deepEqual(setCalls(world.events), [[previousId, OLD_TOKEN], [currentId, NEW_TOKEN]]);
  });

  it('task 迟到调用（lock 已 settle）不得执行任何 Keychain I/O', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    let captured = null;
    const withExclusiveLock = async (task) => {
      captured = task;
      return fabricated;
    };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, ALL_SECRET_STRINGS); return true; },
    );
    assert.ok(captured, 'lock captured the task without calling it');
    await captured().catch(() => {}); // 迟到调用必须被 guard 挡下
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world.events, []);
  });

  it('lock 未等待 task 完成就返回伪造结果 → 固定 fail closed', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async (task) => {
      const pending = task();
      pending.catch(() => {});
      return fabricated;
    };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, ALL_SECRET_STRINGS); return true; },
    );
  });

  it('lock 篡改 task 结果后返回（改字段/加键）→ 固定 fail closed', async () => {
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async (task) => {
      const receipt = await task();
      return { ...receipt, hotReload: true, tampered: 'synthetic-tamper' };
    };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, [...ALL_SECRET_STRINGS, 'synthetic-tamper']); return true; },
    );
  });

  it('lock 同步 throw（未调用 task）→ 固定 fail closed，无底层回显，零 I/O', async () => {
    const boom = new Error('synthetic lock backend boom');
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = () => { throw boom; };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(world.events, []);
  });

  it('lock 异步 reject（未调用 task）→ 固定 fail closed，无底层回显', async () => {
    const boom = new Error('synthetic lock acquire reject');
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async () => { throw boom; };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
    assert.deepEqual(world.events, []);
  });

  it('lock 在 task 成功后 reject（release 失败）→ 固定 fail closed，不返回 receipt', async () => {
    const boom = new Error('synthetic lock release boom');
    const world = createWorld({ backing: new Map([[currentId, OLD_TOKEN]]) });
    const withExclusiveLock = async (task) => {
      await task();
      throw boom;
    };
    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => { assertFixedErrorEnvelope(error, [...ALL_SECRET_STRINGS, boom.message]); return true; },
    );
  });
});

describe('management-auth-rotation 并发串行证据（单进程 fake 排他队列，不声称 production 多进程）', () => {
  /** 内存 fake 排他队列：证明 wrapper 在共享队列下不重叠，仅作单进程证据。 */
  function createSharedExclusiveQueue() {
    let tail = Promise.resolve();
    let active = 0;
    let maxActive = 0;
    const makeLock = () => async (task) => {
      const run = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await task();
        } finally {
          active -= 1;
        }
      };
      const result = tail.then(run);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    return { makeLock, maxActive: () => maxActive };
  }

  it('两个并发 staging 经共享 fake 队列串行执行且各自成功', async () => {
    const writeIds = rotationItemIds('write');
    const readIds = rotationItemIds('read');
    const queue = createSharedExclusiveQueue();
    const worldA = createWorld({ backing: new Map([[writeIds.currentId, OLD_TOKEN]]) });
    const worldB = createWorld({ backing: new Map([[readIds.currentId, OLD_TOKEN]]) });

    const [receiptA, receiptB] = await Promise.all([
      stageManagementAuthKeychainRotation({
        keychain: worldA.keychain,
        scope: 'write',
        newToken: NEW_TOKEN,
        withExclusiveLock: queue.makeLock(),
      }),
      stageManagementAuthKeychainRotation({
        keychain: worldB.keychain,
        scope: 'read',
        newToken: NEW_TOKEN,
        withExclusiveLock: queue.makeLock(),
      }),
    ]);

    assertExactReceipt(receiptA, 'write', false);
    assertExactReceipt(receiptB, 'read', false);
    assert.equal(queue.maxActive(), 1, 'fake exclusive queue must serialize both critical sections');
    assert.equal(worldA.backing.get(writeIds.currentId), NEW_TOKEN);
    assert.equal(worldB.backing.get(readIds.currentId), NEW_TOKEN);
  });
});

describe('validateManagementAuthRotationToken 纯函数行为（零 I/O）', () => {
  it('合法 base64url 边界值 43/128 字符原样返回', () => {
    const tokens = ['A'.repeat(43), 'B'.repeat(128)];
    for (const token of tokens) {
      assert.equal(validateManagementAuthRotationToken(token), token);
    }
  });

  it('非法类型、长度或字符固定 invalid 且不回显输入', () => {
    const invalidValues = [
      undefined,
      null,
      42,
      {},
      'S'.repeat(42),
      'L'.repeat(129),
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)} `,
      `${'A'.repeat(42)}\n`,
      `${'A'.repeat(42)}\0`,
    ];

    for (const value of invalidValues) {
      assert.throws(
        () => validateManagementAuthRotationToken(value),
        (error) => {
          const secrets = typeof value === 'string' ? [value] : [];
          assertFixedError(error, FIXED_INVALID, secrets);
          return true;
        },
      );
    }
  });

  it('相同输入重复调用保持相同结果或固定错误分类', () => {
    const valid = 'R'.repeat(43);
    const invalid = 'R'.repeat(42);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(validateManagementAuthRotationToken(valid), valid);
      assert.throws(
        () => validateManagementAuthRotationToken(invalid),
        (error) => {
          assertFixedError(error, FIXED_INVALID, [invalid]);
          return true;
        },
      );
    }
  });
});

describe('management-auth-rotation 锁 wrapper 错误优先级', () => {
  const { currentId, previousId } = rotationItemIds('write');

  it('task invalid 后 wrapper 抛不同 release error → unavailable', async () => {
    const releaseError = new Error('synthetic invalid-path release sentinel');
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN], [previousId, NEW_TOKEN]]),
    });
    const withExclusiveLock = async (task) => {
      try {
        return await task();
      } catch {
        throw releaseError;
      }
    };

    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => {
        assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, releaseError.message]);
        return true;
      },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });

  it('task recovery 后 wrapper 抛不同 release error → unavailable', async () => {
    const releaseError = new Error('synthetic recovery-path release sentinel');
    const world = createWorld({ backing: new Map([[currentId, NEW_TOKEN]]) });
    const withExclusiveLock = async (task) => {
      try {
        return await task();
      } catch {
        throw releaseError;
      }
    };

    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => {
        assertFixedError(error, FIXED_UNAVAILABLE, [...ALL_SECRET_STRINGS, releaseError.message]);
        return true;
      },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });

  it('wrapper 原样重抛同一 task error 引用 → 保留 task 分类与引用', async () => {
    const world = createWorld({
      backing: new Map([[currentId, OLD_TOKEN], [previousId, NEW_TOKEN]]),
    });
    let taskError = null;
    const withExclusiveLock = async (task) => {
      try {
        return await task();
      } catch (error) {
        taskError = error;
        throw error;
      }
    };

    await assert.rejects(
      stageManagementAuthKeychainRotation(validInput(world, { withExclusiveLock })),
      (error) => {
        assert.equal(error, taskError);
        assertFixedError(error, FIXED_INVALID, ALL_SECRET_STRINGS);
        return true;
      },
    );
    assert.deepEqual(setCalls(world.events), []);
    assertNoDelete(world);
  });
});
