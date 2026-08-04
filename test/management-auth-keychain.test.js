import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGEMENT_AUTH_SOURCE_ENV,
  MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV,
  MANAGEMENT_AUTH_SCOPE_MAP,
  parseManagementAuthScopeList,
  parseManagementAuthEnv,
  validateManagementAuthOptions,
  loadManagementAuthTokens,
} from '../src/management-auth-keychain.js';

// 合成 sentinel：仅用于断言映射/透传，禁止真实凭证。
const FULL = 'makc-full-sentinel';
const READ = 'makc-read-sentinel';
const PREV_READ = 'makc-previous-read-sentinel';
const WRITE = 'makc-write-sentinel';
const PREV_WRITE = 'makc-previous-write-sentinel';
const ADMIN = 'makc-admin-sentinel';
const ALL_SENTINELS = [FULL, READ, PREV_READ, WRITE, PREV_WRITE, ADMIN];

/** 六个 scope 的全量合法声明（映射表顺序）。 */
const ALL_SCOPES = ['full', 'read', 'previous-read', 'write', 'previous-write', 'admin'];

/** scope → 合成值，用于填充 fake Keychain backing。 */
const SCOPE_VALUES = new Map([
  ['full', FULL],
  ['read', READ],
  ['previous-read', PREV_READ],
  ['write', WRITE],
  ['previous-write', PREV_WRITE],
  ['admin', ADMIN],
]);

/**
 * 断言文本不含任一合成 sentinel（失败消息本身也不回显 sentinel）。
 * @param {string} text
 * @param {string} label
 */
function assertNoSentinels(text, label) {
  const joined = String(text);
  for (const secret of ALL_SENTINELS) {
    assert.equal(joined.includes(secret), false, `${label} must not contain a synthetic sentinel`);
  }
}

/**
 * 记录型内存 Keychain fake：get 顺序可查，永远不会触达真实 macOS Keychain。
 * @param {Map<string, unknown>} backing
 * @param {{ failOn?: (itemId: string, index: number) => Error | undefined }} [hooks]
 */
function recordingKeychain(backing, hooks = {}) {
  const gets = [];
  return {
    gets,
    async get(id) {
      gets.push(id);
      if (typeof hooks.failOn === 'function') {
        const error = hooks.failOn(id, gets.length - 1);
        if (error) throw error;
      }
      if (!backing.has(id)) {
        const missing = new Error('keychain-item-missing');
        missing.code = 'keychain-item-missing';
        throw missing;
      }
      return backing.get(id);
    },
  };
}

/**
 * 以 scope 列表填充 backing（itemId 来自固定映射）。
 * @param {string[]} scopes
 * @returns {Map<string, unknown>}
 */
function backingFor(scopes) {
  const backing = new Map();
  for (const scope of scopes) {
    const def = MANAGEMENT_AUTH_SCOPE_MAP.find((entry) => entry.scope === scope);
    backing.set(def.itemId, SCOPE_VALUES.get(scope));
  }
  return backing;
}

describe('management-auth-keychain 固定映射', () => {
  it('映射表覆盖六 scope，itemId 与 optionKey 固定', () => {
    assert.deepEqual(
      MANAGEMENT_AUTH_SCOPE_MAP.map(({ scope, itemId, optionKey, current, requires }) => (
        { scope, itemId, optionKey, current, requires }
      )),
      [
        { scope: 'full', itemId: 'management-auth.full', optionKey: 'authToken', current: true, requires: null },
        { scope: 'read', itemId: 'management-auth.read', optionKey: 'readToken', current: true, requires: null },
        { scope: 'previous-read', itemId: 'management-auth.read.previous', optionKey: 'previousReadToken', current: false, requires: 'read' },
        { scope: 'write', itemId: 'management-auth.write', optionKey: 'writeToken', current: true, requires: null },
        { scope: 'previous-write', itemId: 'management-auth.write.previous', optionKey: 'previousWriteToken', current: false, requires: 'write' },
        { scope: 'admin', itemId: 'management-auth.admin', optionKey: 'adminToken', current: true, requires: null },
      ],
    );
    // 映射表冻结，运行期不可改写
    assert.equal(Object.isFrozen(MANAGEMENT_AUTH_SCOPE_MAP), true);
    assert.ok(MANAGEMENT_AUTH_SCOPE_MAP.every((entry) => Object.isFrozen(entry)));
  });
});

describe('management-auth-keychain scope 列表解析', () => {
  it('逗号 split、逐项 trim、保持声明顺序', () => {
    assert.deepEqual(
      parseManagementAuthScopeList(' write , previous-write , admin '),
      ['write', 'previous-write', 'admin'],
    );
    assert.deepEqual(parseManagementAuthScopeList('admin,write'), ['admin', 'write']);
    assert.deepEqual(parseManagementAuthScopeList(ALL_SCOPES.join(',')), ALL_SCOPES);
  });

  it('拒绝非字符串/空串/空项/未知/大小写变体/重复/previous 失配/无 current', () => {
    const cases = [
      [undefined, /scope/i],
      ['', /scope/i],
      ['   ', /scope/i],
      ['write,,admin', /scope/i],
      ['write,bogus', /scope/i],
      ['write,WRITE', /scope/i],
      ['write,write,admin', /duplicate/i],
      ['previous-read', /previous|current/i],
      ['previous-write', /previous|current/i],
      ['read,previous-write', /previous|current/i],
      ['write,previous-read', /previous|current/i],
    ];
    for (const [raw, match] of cases) {
      assert.throws(() => parseManagementAuthScopeList(raw), match, `must reject: ${JSON.stringify(raw)}`);
    }
  });
});

describe('management-auth-keychain selector 与 direct token 互斥（env）', () => {
  it('source 未定义且 scopes 未定义 → legacy', () => {
    assert.deepEqual(parseManagementAuthEnv({}), { mode: 'legacy', scopes: undefined });
    assert.deepEqual(parseManagementAuthEnv({ UNRELATED: 'x' }), { mode: 'legacy', scopes: undefined });
  });

  it('source 未定义但 scopes 已定义 → 拒绝', () => {
    assert.throws(
      () => parseManagementAuthEnv({ [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: 'write' }),
      /LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES/,
    );
    assert.throws(
      () => parseManagementAuthEnv({ [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: '' }),
      /LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES/,
    );
  });

  it('selector 只接受精确小写 keychain；空串/空白/大小写变体/其它值全部拒绝', () => {
    for (const raw of ['', '   ', 'KEYCHAIN', 'Keychain', 'keychain ', ' keychain', 'env', 'file']) {
      assert.throws(
        () => parseManagementAuthEnv({
          [MANAGEMENT_AUTH_SOURCE_ENV]: raw,
          [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: 'write',
        }),
        /LINKE_MANAGEMENT_AUTH_SOURCE|management auth source/i,
        `must reject selector ${JSON.stringify(raw)}`,
      );
    }
  });

  it('keychain 模式缺 scopes 或 scopes 非法 → 拒绝', () => {
    assert.throws(
      () => parseManagementAuthEnv({ [MANAGEMENT_AUTH_SOURCE_ENV]: 'keychain' }),
      /scope/i,
    );
    assert.throws(
      () => parseManagementAuthEnv({
        [MANAGEMENT_AUTH_SOURCE_ENV]: 'keychain',
        [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: 'previous-write',
      }),
      /previous|current/i,
    );
  });

  it('keychain 模式与七个 direct token 环境变量（含空串）混用全部拒绝且无 fallback', () => {
    const tokenEnvs = [
      'LINKE_AUTH_TOKEN',
      'LINKE_TOKEN',
      'LINKE_READ_TOKEN',
      'LINKE_PREVIOUS_READ_TOKEN',
      'LINKE_WRITE_TOKEN',
      'LINKE_PREVIOUS_WRITE_TOKEN',
      'LINKE_ADMIN_TOKEN',
    ];
    for (const name of tokenEnvs) {
      for (const value of [FULL, '']) {
        let thrown = null;
        try {
          parseManagementAuthEnv({
            [MANAGEMENT_AUTH_SOURCE_ENV]: 'keychain',
            [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: 'write,admin',
            [name]: value,
          });
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown instanceof Error, `${name}=${JSON.stringify(value)} must throw`);
        assert.match(String(thrown.message), /token/i, `${name} error must use stable wording`);
        assertNoSentinels(String(thrown.message), `${name} error message`);
        assertNoSentinels(String(thrown.stack || ''), `${name} error stack`);
      }
    }
  });

  it('合法 keychain selector/scopes 返回 keychain mode 与原序 scopes', () => {
    assert.deepEqual(
      parseManagementAuthEnv({
        [MANAGEMENT_AUTH_SOURCE_ENV]: 'keychain',
        [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: ' write , previous-write , admin ',
      }),
      { mode: 'keychain', scopes: ['write', 'previous-write', 'admin'] },
    );
  });
});

describe('management-auth-keychain startController 选项校验', () => {
  it('managementAuthKeychainScopes 未定义 → legacy（null）', () => {
    assert.equal(validateManagementAuthOptions({}), null);
    assert.equal(validateManagementAuthOptions({ authToken: FULL }), null);
  });

  it('非数组 scopes（含 null/字符串/对象/数字）在 keychain get 前拒绝', () => {
    for (const raw of [null, 'write', 42, { scope: 'write' }, ['write', 42], ['write', '']]) {
      assert.throws(
        () => validateManagementAuthOptions({ managementAuthKeychainScopes: raw }),
        /array|scope/i,
        `must reject ${JSON.stringify(raw)}`,
      );
    }
  });

  it('scopes 内容与 pairing 规则复用同一校验', () => {
    assert.throws(
      () => validateManagementAuthOptions({ managementAuthKeychainScopes: ['write', 'bogus'] }),
      /scope/i,
    );
    assert.throws(
      () => validateManagementAuthOptions({ managementAuthKeychainScopes: ['previous-write'] }),
      /previous|current/i,
    );
    assert.throws(
      () => validateManagementAuthOptions({ managementAuthKeychainScopes: [] }),
      /current/i,
    );
  });

  it('scopes 与任一直接 token 选项（含空串）混用拒绝', () => {
    const keys = ['authToken', 'readToken', 'previousReadToken', 'writeToken', 'previousWriteToken', 'adminToken'];
    for (const key of keys) {
      for (const value of [FULL, '']) {
        assert.throws(
          () => validateManagementAuthOptions({
            managementAuthKeychainScopes: ['write', 'admin'],
            [key]: value,
          }),
          /token/i,
          `${key}=${JSON.stringify(value)} must throw`,
        );
      }
    }
  });

  it('合法 scopes 数组原序返回', () => {
    assert.deepEqual(
      validateManagementAuthOptions({ managementAuthKeychainScopes: ['write', 'previous-write', 'admin'] }),
      ['write', 'previous-write', 'admin'],
    );
  });
});

describe('management-auth-keychain 加载器', () => {
  it('按声明顺序只读取声明项并映射到 option 字段', async () => {
    const keychain = recordingKeychain(backingFor(ALL_SCOPES));
    const tokens = await loadManagementAuthTokens(keychain, ['write', 'previous-write', 'admin']);
    assert.deepEqual(keychain.gets, [
      'management-auth.write',
      'management-auth.write.previous',
      'management-auth.admin',
    ]);
    assert.deepEqual(tokens, {
      writeToken: WRITE,
      previousWriteToken: PREV_WRITE,
      adminToken: ADMIN,
    });
  });

  it('全量声明按映射表顺序读取并完整映射六字段', async () => {
    const keychain = recordingKeychain(backingFor(ALL_SCOPES));
    const tokens = await loadManagementAuthTokens(keychain, ALL_SCOPES);
    assert.deepEqual(keychain.gets, [
      'management-auth.full',
      'management-auth.read',
      'management-auth.read.previous',
      'management-auth.write',
      'management-auth.write.previous',
      'management-auth.admin',
    ]);
    assert.deepEqual(tokens, {
      authToken: FULL,
      readToken: READ,
      previousReadToken: PREV_READ,
      writeToken: WRITE,
      previousWriteToken: PREV_WRITE,
      adminToken: ADMIN,
    });
  });

  it('missing/unavailable/原始错误的读取拒绝原样传播，无 fallback', async () => {
    const missing = new Error('keychain-item-missing');
    missing.code = 'keychain-item-missing';
    const unavailable = new Error('keychain-unavailable');
    unavailable.code = 'keychain-unavailable';
    const raw = new Error(`raw boom ${WRITE}`);

    for (const expected of [missing, unavailable, raw]) {
      const keychain = recordingKeychain(backingFor(['write', 'admin']), {
        failOn: () => expected,
      });
      await assert.rejects(
        loadManagementAuthTokens(keychain, ['write', 'admin']),
        (error) => error === expected,
      );
    }
  });

  it('非字符串/空串/全空白值以固定非秘密错误 fail closed', async () => {
    for (const bad of [42, null, undefined, '', '   ']) {
      const backing = backingFor(['write', 'admin']);
      backing.set('management-auth.write', bad);
      const keychain = recordingKeychain(backing);
      let thrown = null;
      try {
        await loadManagementAuthTokens(keychain, ['write', 'admin']);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof Error, `value ${JSON.stringify(bad)} must fail closed`);
      assert.match(String(thrown.message), /non-empty secret/);
      assertNoSentinels(String(thrown.message), 'bad-value error message');
      assertNoSentinels(String(thrown.stack || ''), 'bad-value error stack');
    }
  });

  it('失败后不再发起任何额外 get', async () => {
    const boom = new Error('keychain read failed (synthetic)');
    const keychain = recordingKeychain(backingFor(['write', 'previous-write', 'admin']), {
      failOn: (id, index) => (index === 1 ? boom : undefined),
    });
    await assert.rejects(
      loadManagementAuthTokens(keychain, ['write', 'previous-write', 'admin']),
      (error) => error === boom,
    );
    assert.deepEqual(keychain.gets, ['management-auth.write', 'management-auth.write.previous']);
  });

  it('未知 scope 防御性拒绝（不触碰 keychain）', async () => {
    const keychain = recordingKeychain(new Map());
    await assert.rejects(
      loadManagementAuthTokens(keychain, ['bogus']),
      /scope/i,
    );
    assert.deepEqual(keychain.gets, []);
  });
});

describe('management-auth-keychain 校验快照独立性（TOCTOU）', () => {
  it('validateManagementAuthOptions 返回与输入脱离的不可变快照', () => {
    const input = ['write', 'previous-write', 'admin'];
    const validated = validateManagementAuthOptions({ managementAuthKeychainScopes: input });
    // 快照必须是独立副本而非调用方原数组引用
    assert.notEqual(validated, input, 'validated scopes must not be the caller array');
    assert.deepEqual(validated, ['write', 'previous-write', 'admin']);
    // 快照不可变：ESM 严格模式下写入/push 抛 TypeError
    assert.equal(Object.isFrozen(validated), true, 'validated scopes must be frozen');
    assert.throws(() => {
      validated[0] = 'admin';
    }, TypeError);
    assert.throws(() => {
      validated.push('read');
    }, TypeError);
    // 校验后改写原数组：已得到的校验结果不变
    input[0] = 'read';
    input.push('full');
    assert.deepEqual(validated, ['write', 'previous-write', 'admin']);
  });

  it('await 之间改写原输入数组不改变后续异步读取集合与顺序', async () => {
    const input = ['write', 'previous-write', 'admin'];
    const validated = validateManagementAuthOptions({ managementAuthKeychainScopes: input });
    const keychain = recordingKeychain(backingFor(ALL_SCOPES), {
      failOn: (id, index) => {
        if (index === 0) {
          // 首个 get 之后、后续 get 之前突变原数组（TOCTOU 攻击面）
          input.length = 0;
          input.push('admin');
        }
        return undefined;
      },
    });
    const tokens = await loadManagementAuthTokens(keychain, validated);
    // 实际读取集合/顺序仍等于通过校验的声明，而非被改写后的输入
    assert.deepEqual(keychain.gets, [
      'management-auth.write',
      'management-auth.write.previous',
      'management-auth.admin',
    ]);
    assert.deepEqual(tokens, {
      writeToken: WRITE,
      previousWriteToken: PREV_WRITE,
      adminToken: ADMIN,
    });
  });

  it('env 解析路径同样产出不可变 scopes 快照', () => {
    const parsed = parseManagementAuthEnv({
      [MANAGEMENT_AUTH_SOURCE_ENV]: 'keychain',
      [MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV]: 'write,previous-write,admin',
    });
    assert.deepEqual(parsed.scopes, ['write', 'previous-write', 'admin']);
    assert.equal(Object.isFrozen(parsed.scopes), true, 'parsed scopes must be frozen');
  });
});
