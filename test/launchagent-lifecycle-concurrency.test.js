/**
 * Linke V1.46 Task 6B.0 concurrency tests.
 *
 * Task 1 (GREEN): process identity reader — existence-safe; behavior registered only when module exists.
 * Task 2: transaction/claim observations + claim-fenced MIR recovery acquisition primitives.
 * Task 3 (GREEN): coordinator process identities on every new transaction/MIR lock.
 * Task 4 (RED): real Node-process recovery-lock proof via lock-contender helper protocol.
 *   Fail only because test/helpers/launchagent-lock-contender.js is absent (bounded child protocol).
 *   Forbidden: grep production source; real host/launchctl; production test hooks; create the helper here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as metadataStoreModule from '../src/launchagent-lifecycle/metadata-store.js';
import {
  LaunchAgentLifecycleError,
  LAUNCHAGENT_LIFECYCLE_CODES,
  validateLaunchAgentReceipt,
} from '../src/launchagent-lifecycle/contracts.js';
import { createLaunchAgentProcessIdentityReader } from '../src/launchagent-lifecycle/process-identity.js';
import { createLaunchAgentLifecycleCoordinator } from '../src/launchagent-lifecycle/transaction-coordinator.js';
import { createLaunchAgentLifecycleHarness } from './helpers/launchagent-lifecycle-harness.js';

const processIdentityUrl = new URL(
  '../src/launchagent-lifecycle/process-identity.js',
  import.meta.url,
);
const processIdentityPath = fileURLToPath(processIdentityUrl);
const processIdentityExists = existsSync(processIdentityPath);

// ---------------------------------------------------------------------------
// 固定生产命令契约（经 ForTest 注入的 fake 观测，不触真实 host）
// ---------------------------------------------------------------------------

const SYSCTL_PATH = '/usr/sbin/sysctl';
const SYSCTL_ARGV = Object.freeze(['-n', 'kern.boottime']);
const PS_PATH = '/bin/ps';
const PS_ARGV_FOR = (pid) => Object.freeze(['-p', String(pid), '-o', 'lstart=']);

const BOOT_PREFIX = 'boot-sha256-';
const PROCESS_START_PREFIX = 'process-start-sha256-';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_STDOUT_UTF8_BYTES = 4096;

/** 字面 fixture raw bytes（独立 hash；不调用未来生产 helper）。 */
const RAW_BOOT_A = '{ sec = 1700000001, usec = 111 } Fri Nov 14 22:13:21 2023\n';
const RAW_BOOT_B = '{ sec = 1700009999, usec = 222 } Sat Nov 15 01:00:00 2023\n';
const RAW_LSTART_A = 'Fri Nov 14 22:14:00 2023\n';
const RAW_LSTART_B = 'Sat Nov 15 03:30:00 2023\n';
const RAW_BOOT_PADDED = `  ${RAW_BOOT_A.trim()}  \n`;
const RAW_LSTART_PADDED = `  ${RAW_LSTART_A.trim()}  \n`;

const CANARY_STDOUT = 'CANARY_STDOUT_should_never_surface';
const CANARY_STDERR = 'CANARY_STDERR_should_never_surface';
const CANARY_PATH = '/tmp/linke-canary-path-SHOULD-NOT-LEAK';
const CANARY_DATE = 'Wed Dec 31 23:59:59 2099';
const CANARY_ERROR = 'raw-error-message-MUST-NOT-LEAK';
const CANARY_HEX_NOISE = 'deadbeef-canary-hex-noise';

const DEFAULT_CANARIES = Object.freeze([
  CANARY_STDOUT,
  CANARY_STDERR,
  CANARY_PATH,
  CANARY_DATE,
  CANARY_ERROR,
  CANARY_HEX_NOISE,
  RAW_BOOT_A,
  RAW_BOOT_B,
  RAW_LSTART_A,
  RAW_LSTART_B,
  SYSCTL_PATH,
  PS_PATH,
  'kern.boottime',
  'lstart=',
]);

const OBSERVE_STATUSES = Object.freeze([
  'dead',
  'alive-same-owner',
  'pid-reused',
  'unavailable',
  'boot-session-mismatch',
]);

// ---------------------------------------------------------------------------
// 独立 digest 与断言 helper（仅测试侧）
// ---------------------------------------------------------------------------

function digestHexFromLiteralRaw(raw) {
  assert.equal(typeof raw, 'string', 'fixture raw must be string literal');
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

const BOOT_A_HEX = digestHexFromLiteralRaw(RAW_BOOT_A);
const BOOT_B_HEX = digestHexFromLiteralRaw(RAW_BOOT_B);
const LSTART_A_HEX = digestHexFromLiteralRaw(RAW_LSTART_A);
const LSTART_B_HEX = digestHexFromLiteralRaw(RAW_LSTART_B);
const BOOT_A_FROM_PADDED_HEX = digestHexFromLiteralRaw(RAW_BOOT_PADDED);
const LSTART_A_FROM_PADDED_HEX = digestHexFromLiteralRaw(RAW_LSTART_PADDED);

assert.equal(BOOT_A_HEX, BOOT_A_FROM_PADDED_HEX, 'trim() must normalize boot fixture padding');
assert.equal(LSTART_A_HEX, LSTART_A_FROM_PADDED_HEX, 'trim() must normalize lstart fixture padding');
assert.notEqual(BOOT_A_HEX, BOOT_B_HEX);
assert.notEqual(LSTART_A_HEX, LSTART_B_HEX);
assert.match(BOOT_A_HEX, SHA256_HEX);
assert.match(LSTART_A_HEX, SHA256_HEX);

const BOOT_ID_A = `${BOOT_PREFIX}${BOOT_A_HEX}`;
const BOOT_ID_B = `${BOOT_PREFIX}${BOOT_B_HEX}`;
const PROCESS_ID_A = `${PROCESS_START_PREFIX}${LSTART_A_HEX}`;
const PROCESS_ID_B = `${PROCESS_START_PREFIX}${LSTART_B_HEX}`;

function assertDeepFrozen(value, location = 'value') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${location} must be frozen`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, `${location}.${String(key)}`);
    }
  }
}

function assertExactKeys(value, expectedKeys, location = 'value') {
  assert.equal(value === null || typeof value !== 'object', false, `${location} must be object`);
  const keys = Reflect.ownKeys(value)
    .filter((k) => typeof k === 'string')
    .sort();
  assert.deepEqual(keys, [...expectedKeys].sort(), `${location} exact keys`);
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (Buffer.isBuffer(value)) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') out.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      collectStrings(descriptor.value, out);
    }
  }
  return out;
}

function assertNoLeakage(value, canaries, label) {
  let text;
  if (value instanceof Error) {
    const ownData = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        continue;
      }
      ownData[key] = descriptor.value;
    }
    text = [
      String(value.name ?? ''),
      String(value.code ?? ''),
      String(value.message ?? ''),
      ...collectStrings(ownData),
    ].join('\n');
  } else {
    text = JSON.stringify(collectStrings(value));
  }
  for (const canary of canaries) {
    assert.equal(
      text.includes(canary),
      false,
      `${label} must not leak ${JSON.stringify(canary)}`,
    );
  }
}

function ownEnumerableNames(object) {
  return Reflect.ownKeys(object)
    .filter((key) => typeof key === 'string')
    .filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && descriptor.enumerable;
    })
    .sort();
}

function ownEnumerableMethodNames(object) {
  return ownEnumerableNames(object).filter((key) => typeof object[key] === 'function');
}

function withOwnData(fixture, key, value) {
  const candidate = { ...fixture };
  Object.defineProperty(candidate, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return candidate;
}

function withAccessor(fixture, key, onRead = () => {}) {
  const candidate = { ...fixture };
  Object.defineProperty(candidate, key, {
    configurable: true,
    enumerable: true,
    get() {
      onRead();
      return 'forbidden';
    },
  });
  return candidate;
}

function makeErrno(code, message = CANARY_ERROR) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function availableIdentity(value) {
  return { available: true, value };
}

function unavailableIdentity() {
  return { available: false, value: null };
}

function lockRecord({
  ownerPid = 4242,
  bootSessionIdentity = availableIdentity(BOOT_ID_A),
  processStartIdentity = availableIdentity(PROCESS_ID_A),
  extra = null,
} = {}) {
  const base = {
    ownerPid,
    bootSessionIdentity,
    processStartIdentity,
  };
  if (extra && typeof extra === 'object') {
    return { ...base, ...extra };
  }
  return base;
}

function assertClosedObserve(result, status, label) {
  assert.equal(result === null || typeof result !== 'object', false, `${label} must be object`);
  assertExactKeys(result, ['status'], label);
  assert.equal(result.status, status, `${label} status`);
  assert.ok(OBSERVE_STATUSES.includes(result.status), `${label} closed status vocabulary`);
  assertDeepFrozen(result, label);
  assertNoLeakage(result, DEFAULT_CANARIES, label);
  // detached：调用方不得通过结果突变共享内部表
  assert.throws(() => {
    result.status = 'mutated';
  });
  assert.equal(result.status, status);
}

function assertIdentityProjection(identity, { available, valuePrefix = null, value = null }, label) {
  assertExactKeys(identity, ['available', 'value'], label);
  assert.equal(identity.available, available, `${label}.available`);
  if (available === false) {
    assert.equal(identity.value, null, `${label}.value must be null when unavailable`);
  } else {
    assert.equal(typeof identity.value, 'string', `${label}.value string`);
    if (value !== null) {
      assert.equal(identity.value, value, `${label}.value exact`);
    }
    if (valuePrefix !== null) {
      assert.equal(identity.value.startsWith(valuePrefix), true, `${label} prefix`);
      const hex = identity.value.slice(valuePrefix.length);
      assert.match(hex, SHA256_HEX, `${label} hex digest`);
      assert.equal(hex, hex.toLowerCase(), `${label} lowercase hex`);
    }
  }
  assertDeepFrozen(identity, label);
  assertNoLeakage(identity, DEFAULT_CANARIES, label);
}

function assertCurrentSnapshot(snapshot, expected, label = 'current()') {
  assertExactKeys(snapshot, ['bootSessionIdentity', 'processStartIdentity'], label);
  assertDeepFrozen(snapshot, label);
  assertIdentityProjection(
    snapshot.bootSessionIdentity,
    expected.bootSessionIdentity,
    `${label}.bootSessionIdentity`,
  );
  assertIdentityProjection(
    snapshot.processStartIdentity,
    expected.processStartIdentity,
    `${label}.processStartIdentity`,
  );
  assertNoLeakage(snapshot, DEFAULT_CANARIES, label);
}

function createCallRecorder() {
  const calls = [];
  return {
    calls,
    record(kind, payload) {
      calls.push({ kind, ...payload });
    },
    of(kind) {
      return calls.filter((c) => c.kind === kind);
    },
  };
}

function createExecFileRouter(routes, recorder) {
  return async function execFile(file, args, options) {
    recorder.record('execFile', {
      file,
      args: Array.isArray(args) ? [...args] : args,
      options,
    });
    const key = `${file} ${Array.isArray(args) ? args.join(' ') : ''}`;
    if (typeof routes[key] === 'function') {
      return routes[key](file, args, options);
    }
    if (Object.hasOwn(routes, file) && typeof routes[file] === 'function') {
      return routes[file](file, args, options);
    }
    if (typeof routes.default === 'function') {
      return routes.default(file, args, options);
    }
    const err = new Error(`${CANARY_ERROR}: unexpected execFile ${file}`);
    err.code = 'ENOENT';
    throw err;
  };
}

function createKillStub(behavior, recorder) {
  return function kill(pid, signal) {
    recorder.record('kill', { pid, signal });
    if (typeof behavior === 'function') {
      return behavior(pid, signal);
    }
    if (behavior && typeof behavior === 'object' && behavior.throw) {
      throw behavior.throw;
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// 存在性：模块缺失时唯一允许的 RED
// ---------------------------------------------------------------------------

test('process identity module exists before process-identity behavior tests', () => {
  assert.equal(
    processIdentityExists,
    true,
    'expected src/launchagent-lifecycle/process-identity.js to exist before process identity behavior tests',
  );
});

// ---------------------------------------------------------------------------
// 行为测试：仅在模块存在时注册，避免 ERR_MODULE_NOT_FOUND 噪声
// ---------------------------------------------------------------------------

if (processIdentityExists) {
  const processIdentity = await import(processIdentityUrl);
  const {
    createLaunchAgentProcessIdentityReader,
    createLaunchAgentProcessIdentityReaderForTest,
  } = processIdentity;

  test('process identity exports both production and ForTest factories as functions', () => {
    assert.equal(typeof createLaunchAgentProcessIdentityReader, 'function');
    assert.equal(typeof createLaunchAgentProcessIdentityReaderForTest, 'function');
  });

  test('process identity production factory is zero-arg and returns frozen {current,observe} only', () => {
    assert.equal(createLaunchAgentProcessIdentityReader.length, 0);
    const reader = createLaunchAgentProcessIdentityReader();
    assert.deepEqual(ownEnumerableMethodNames(reader).sort(), ['current', 'observe'].sort());
    assertDeepFrozen(reader, 'production reader');
    for (const forbidden of [
      'execFile',
      'kill',
      'sysctl',
      'ps',
      'hash',
      'readFile',
      'spawn',
      'exec',
    ]) {
      assert.equal(
        ownEnumerableNames(reader).includes(forbidden),
        false,
        `reader must not expose ${forbidden}`,
      );
    }
  });

  test('process identity ForTest factory accepts exact {execFile,kill} and freezes reader surface', () => {
    const recorder = createCallRecorder();
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile: createExecFileRouter({
        default: async () => ({ stdout: RAW_BOOT_A }),
      }, recorder),
      kill: createKillStub(() => undefined, recorder),
    });
    assert.deepEqual(ownEnumerableMethodNames(reader).sort(), ['current', 'observe'].sort());
    assertDeepFrozen(reader, 'forTest reader');
    assert.equal(typeof reader.current, 'function');
    assert.equal(typeof reader.observe, 'function');
  });

  test('process identity ForTest rejects unknown injection keys and hostile accessors without probing', () => {
    const execFile = async () => ({ stdout: RAW_BOOT_A });
    const kill = () => undefined;
    let hits = 0;

    assert.throws(() => createLaunchAgentProcessIdentityReaderForTest(withOwnData({
      execFile,
      kill,
    }, 'extra', 1)));

    assert.throws(() => createLaunchAgentProcessIdentityReaderForTest(withAccessor({
      execFile,
      kill,
    }, 'evil', () => {
      hits += 1;
    })));
    assert.equal(hits, 0);

    assert.throws(() => createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      // missing kill
    }));

    assert.throws(() => createLaunchAgentProcessIdentityReaderForTest({
      kill,
      // missing execFile
    }));

    assert.throws(() => createLaunchAgentProcessIdentityReaderForTest({
      execFile: 'not-a-function',
      kill,
    }));

    assert.throws(() => createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      kill: 'not-a-function',
    }));
  });

  // -------------------------------------------------------------------------
  // current() — 命令路径/argv、trim hash 前缀、stdout 边界
  // -------------------------------------------------------------------------

  test('process identity current() issues exact sysctl and ps argv and returns trimmed digests', async () => {
    const recorder = createCallRecorder();
    const pid = process.pid;
    const execFile = createExecFileRouter({
      async [SYSCTL_PATH](file, args) {
        assert.equal(file, SYSCTL_PATH);
        assert.deepEqual(args, [...SYSCTL_ARGV]);
        return { stdout: RAW_BOOT_PADDED };
      },
      async [PS_PATH](file, args) {
        assert.equal(file, PS_PATH);
        assert.deepEqual(args, [...PS_ARGV_FOR(pid)]);
        return { stdout: RAW_LSTART_PADDED };
      },
    }, recorder);
    const kill = createKillStub(() => {
      assert.fail('current() must not call kill');
    }, recorder);

    const reader = createLaunchAgentProcessIdentityReaderForTest({ execFile, kill });
    const snapshot = await reader.current();

    assertCurrentSnapshot(snapshot, {
      bootSessionIdentity: { available: true, value: BOOT_ID_A },
      processStartIdentity: { available: true, value: PROCESS_ID_A },
    });

    const execCalls = recorder.of('execFile');
    assert.equal(execCalls.length, 2, 'current() must call sysctl then ps exactly once each');
    assert.equal(execCalls[0].file, SYSCTL_PATH);
    assert.deepEqual(execCalls[0].args, [...SYSCTL_ARGV]);
    assert.equal(execCalls[1].file, PS_PATH);
    assert.deepEqual(execCalls[1].args, [...PS_ARGV_FOR(pid)]);
    assert.equal(recorder.of('kill').length, 0);
  });

  test('process identity current() marks boot unavailable on sysctl error without leaking', async () => {
    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) {
        const err = makeErrno('EPERM', `${CANARY_ERROR} ${CANARY_PATH} ${CANARY_STDERR}`);
        err.stderr = CANARY_STDERR;
        err.stdout = CANARY_STDOUT;
        throw err;
      }
      return { stdout: RAW_LSTART_A };
    };
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      kill: createKillStub(() => undefined, recorder),
    });
    const snapshot = await reader.current();
    assert.equal(snapshot.bootSessionIdentity.available, false);
    assert.equal(snapshot.bootSessionIdentity.value, null);
    assertNoLeakage(snapshot, DEFAULT_CANARIES, 'current sysctl error');
  });

  test('process identity current() marks process-start unavailable on ps error without leaking', async () => {
    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
      const err = makeErrno('ENOENT', `${CANARY_ERROR} ${CANARY_DATE}`);
      err.stdout = CANARY_STDOUT;
      throw err;
    };
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      kill: createKillStub(() => undefined, recorder),
    });
    const snapshot = await reader.current();
    assert.equal(snapshot.bootSessionIdentity.available, true);
    assert.equal(snapshot.bootSessionIdentity.value, BOOT_ID_A);
    assert.equal(snapshot.processStartIdentity.available, false);
    assert.equal(snapshot.processStartIdentity.value, null);
    assertNoLeakage(snapshot, DEFAULT_CANARIES, 'current ps error');
  });

  test('process identity current() treats non-string empty whitespace oversize and NUL stdout as unavailable', async () => {
    const oversize = `${'x'.repeat(MAX_STDOUT_UTF8_BYTES + 1)}\n`;
    assert.ok(Buffer.byteLength(oversize, 'utf8') > MAX_STDOUT_UTF8_BYTES);

    const cases = [
      { name: 'non-string-null', stdout: null },
      { name: 'non-string-buffer', stdout: Buffer.from(RAW_BOOT_A, 'utf8') },
      { name: 'non-string-number', stdout: 42 },
      { name: 'empty', stdout: '' },
      { name: 'whitespace', stdout: ' \n\t  ' },
      { name: 'oversize', stdout: oversize },
      { name: 'nul', stdout: `good${String.fromCharCode(0)}tail\n` },
    ];

    for (const scenario of cases) {
      const recorder = createCallRecorder();
      const execFile = async (file, args) => {
        recorder.record('execFile', { file, args: [...args] });
        return { stdout: scenario.stdout };
      };
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile,
        kill: createKillStub(() => undefined, recorder),
      });
      const snapshot = await reader.current();
      assert.equal(
        snapshot.bootSessionIdentity.available,
        false,
        `${scenario.name}: boot must be unavailable`,
      );
      assert.equal(snapshot.bootSessionIdentity.value, null, `${scenario.name}: boot value null`);
      // ps 仍可能被调用；若同样 malformed 则 process-start 也 unavailable
      if (scenario.name === 'non-string-null'
        || scenario.name === 'non-string-buffer'
        || scenario.name === 'non-string-number'
        || scenario.name === 'empty'
        || scenario.name === 'whitespace'
        || scenario.name === 'oversize'
        || scenario.name === 'nul') {
        assert.equal(
          snapshot.processStartIdentity.available,
          false,
          `${scenario.name}: process-start must be unavailable for same bound stdout`,
        );
        assert.equal(snapshot.processStartIdentity.value, null);
      }
      assertDeepFrozen(snapshot, scenario.name);
      assertNoLeakage(snapshot, DEFAULT_CANARIES, scenario.name);
    }
  });

  test('process identity current() applies oversize bound to trimmed stdout so padded raw stays available', async () => {
    const pad = ' '.repeat(MAX_STDOUT_UTF8_BYTES);
    const rawBoot = `${pad}${RAW_BOOT_A.trim()} ${pad}\n`;
    const rawLstart = `${pad}${RAW_LSTART_A.trim()} ${pad}\n`;
    assert.ok(
      Buffer.byteLength(rawBoot, 'utf8') > MAX_STDOUT_UTF8_BYTES,
      'raw boot stdout must exceed the byte bound before trim',
    );
    assert.ok(
      Buffer.byteLength(rawLstart, 'utf8') > MAX_STDOUT_UTF8_BYTES,
      'raw lstart stdout must exceed the byte bound before trim',
    );
    assert.ok(
      Buffer.byteLength(rawBoot.trim(), 'utf8') <= MAX_STDOUT_UTF8_BYTES,
      'trimmed boot stdout must fit the byte bound',
    );
    assert.ok(
      Buffer.byteLength(rawLstart.trim(), 'utf8') <= MAX_STDOUT_UTF8_BYTES,
      'trimmed lstart stdout must fit the byte bound',
    );
    // 预期 digest 等于对 trim 后内容求 SHA-256
    assert.equal(digestHexFromLiteralRaw(rawBoot), BOOT_A_HEX);
    assert.equal(digestHexFromLiteralRaw(rawLstart), LSTART_A_HEX);

    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) return { stdout: rawBoot };
      return { stdout: rawLstart };
    };
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      kill: createKillStub(() => {
        assert.fail('current() must not call kill');
      }, recorder),
    });
    const snapshot = await reader.current();

    assertCurrentSnapshot(snapshot, {
      bootSessionIdentity: { available: true, value: BOOT_ID_A },
      processStartIdentity: { available: true, value: PROCESS_ID_A },
    });

    const execCalls = recorder.of('execFile');
    assert.equal(execCalls.length, 2, 'current() must call sysctl then ps exactly once each');
    assert.equal(execCalls[0].file, SYSCTL_PATH);
    assert.equal(execCalls[1].file, PS_PATH);
    assert.equal(recorder.of('kill').length, 0);
  });

  test('process identity current() never exposes raw stdout date newline path or error text', async () => {
    const recorder = createCallRecorder();
    const hostileBoot = `${CANARY_DATE} ${CANARY_PATH}\n`;
    const hostileLstart = `${CANARY_STDOUT}\n`;
    const execFile = async (file) => {
      recorder.record('execFile', { file });
      if (file === SYSCTL_PATH) return { stdout: hostileBoot };
      return { stdout: hostileLstart };
    };
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      kill: createKillStub(() => undefined, recorder),
    });
    const snapshot = await reader.current();
    assert.equal(snapshot.bootSessionIdentity.available, true);
    assert.equal(
      snapshot.bootSessionIdentity.value,
      `${BOOT_PREFIX}${digestHexFromLiteralRaw(hostileBoot)}`,
    );
    assert.equal(snapshot.processStartIdentity.available, true);
    assert.equal(
      snapshot.processStartIdentity.value,
      `${PROCESS_START_PREFIX}${digestHexFromLiteralRaw(hostileLstart)}`,
    );
    assertNoLeakage(snapshot, [
      CANARY_DATE,
      CANARY_PATH,
      CANARY_STDOUT,
      hostileBoot.trim(),
      hostileLstart.trim(),
      hostileBoot,
      hostileLstart,
    ], 'current hostile raw');
  });

  // -------------------------------------------------------------------------
  // observe() — 闭合 status 矩阵与命令顺序
  // -------------------------------------------------------------------------

  test('process identity observe: kill success + matching ps hash => alive-same-owner', async () => {
    const ownerPid = 7771;
    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) {
        assert.deepEqual(args, [...SYSCTL_ARGV]);
        return { stdout: RAW_BOOT_A };
      }
      if (file === PS_PATH) {
        assert.deepEqual(args, [...PS_ARGV_FOR(ownerPid)]);
        return { stdout: RAW_LSTART_A };
      }
      throw makeErrno('ENOENT', CANARY_ERROR);
    };
    const kill = createKillStub((pid, signal) => {
      assert.equal(pid, ownerPid);
      assert.equal(signal, 0);
      return undefined;
    }, recorder);

    const reader = createLaunchAgentProcessIdentityReaderForTest({ execFile, kill });
    const result = await reader.observe(lockRecord({
      ownerPid,
      bootSessionIdentity: availableIdentity(BOOT_ID_A),
      processStartIdentity: availableIdentity(PROCESS_ID_A),
    }));
    assertClosedObserve(result, 'alive-same-owner', 'alive-same-owner');

    assert.equal(recorder.of('kill').length, 1);
    assert.deepEqual(recorder.of('kill')[0], { kind: 'kill', pid: ownerPid, signal: 0 });
    const execCalls = recorder.of('execFile');
    assert.ok(execCalls.some((c) => c.file === SYSCTL_PATH));
    assert.ok(execCalls.some((c) => c.file === PS_PATH));
  });

  test('process identity observe: kill success + differing ps hash => pid-reused', async () => {
    const ownerPid = 7772;
    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
      if (file === PS_PATH) {
        assert.deepEqual(args, [...PS_ARGV_FOR(ownerPid)]);
        return { stdout: RAW_LSTART_B };
      }
      throw makeErrno('ENOENT', CANARY_ERROR);
    };
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile,
      kill: createKillStub(() => undefined, recorder),
    });
    const result = await reader.observe(lockRecord({
      ownerPid,
      bootSessionIdentity: availableIdentity(BOOT_ID_A),
      processStartIdentity: availableIdentity(PROCESS_ID_A),
    }));
    assertClosedObserve(result, 'pid-reused', 'pid-reused');
    assert.equal(recorder.of('kill').length, 1);
    assert.ok(recorder.of('execFile').some((c) => c.file === PS_PATH));
  });

  test('process identity observe: kill ESRCH + matching boot => dead', async () => {
    const ownerPid = 7773;
    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) {
        assert.deepEqual(args, [...SYSCTL_ARGV]);
        return { stdout: RAW_BOOT_A };
      }
      // dead 路径不得依赖 ps
      throw makeErrno('ENOENT', `${CANARY_ERROR} unexpected-ps`);
    };
    const kill = createKillStub(() => {
      throw makeErrno('ESRCH', `${CANARY_ERROR} no-such-process ${CANARY_PATH}`);
    }, recorder);

    const reader = createLaunchAgentProcessIdentityReaderForTest({ execFile, kill });
    const result = await reader.observe(lockRecord({
      ownerPid,
      bootSessionIdentity: availableIdentity(BOOT_ID_A),
      processStartIdentity: availableIdentity(PROCESS_ID_A),
    }));
    assertClosedObserve(result, 'dead', 'dead');
    assert.equal(recorder.of('kill').length, 1);
    assert.equal(recorder.of('kill')[0].signal, 0);
    assert.equal(
      recorder.of('execFile').filter((c) => c.file === PS_PATH).length,
      0,
      'dead must not call ps after ESRCH',
    );
  });

  test('process identity observe: kill EPERM or unknown error => unavailable', async () => {
    const ownerPid = 7774;
    for (const scenario of [
      { name: 'EPERM', err: makeErrno('EPERM', `${CANARY_ERROR} ${CANARY_PATH}`) },
      { name: 'unknown-code', err: makeErrno('EIO', `${CANARY_ERROR} ${CANARY_STDERR}`) },
      { name: 'no-code', err: new Error(`${CANARY_ERROR} plain`) },
    ]) {
      const recorder = createCallRecorder();
      const execFile = async (file, args) => {
        recorder.record('execFile', { file, args: [...args] });
        if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
        throw makeErrno('ENOENT', 'unexpected-ps');
      };
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile,
        kill: createKillStub(() => {
          throw scenario.err;
        }, recorder),
      });
      const result = await reader.observe(lockRecord({ ownerPid }));
      assertClosedObserve(result, 'unavailable', scenario.name);
      assert.equal(recorder.of('kill').length, 1);
      assert.equal(
        recorder.of('execFile').filter((c) => c.file === PS_PATH).length,
        0,
        `${scenario.name}: must not call ps after kill failure`,
      );
    }
  });

  test('process identity observe: sysctl or ps error or malformed output => unavailable', async () => {
    const ownerPid = 7775;
    const scenarios = [
      {
        name: 'sysctl-throw',
        execFile: async (file) => {
          if (file === SYSCTL_PATH) throw makeErrno('EACCES', CANARY_ERROR);
          return { stdout: RAW_LSTART_A };
        },
        killOk: true,
      },
      {
        name: 'sysctl-empty',
        execFile: async (file) => {
          if (file === SYSCTL_PATH) return { stdout: '   \n' };
          return { stdout: RAW_LSTART_A };
        },
        killOk: true,
      },
      {
        name: 'sysctl-nul',
        execFile: async (file) => {
          if (file === SYSCTL_PATH) return { stdout: `x${String.fromCharCode(0)}y` };
          return { stdout: RAW_LSTART_A };
        },
        killOk: true,
      },
      {
        name: 'ps-throw-after-alive',
        execFile: async (file) => {
          if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
          throw makeErrno('EAGAIN', `${CANARY_ERROR} ${CANARY_STDOUT}`);
        },
        killOk: true,
      },
      {
        name: 'ps-non-string',
        execFile: async (file) => {
          if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
          return { stdout: Buffer.from(RAW_LSTART_A) };
        },
        killOk: true,
      },
      {
        name: 'ps-oversize',
        execFile: async (file) => {
          if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
          return { stdout: `${'y'.repeat(MAX_STDOUT_UTF8_BYTES + 8)}\n` };
        },
        killOk: true,
      },
    ];

    for (const scenario of scenarios) {
      const recorder = createCallRecorder();
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          recorder.record('execFile', { file, args: [...args] });
          return scenario.execFile(file, args);
        },
        kill: createKillStub(() => undefined, recorder),
      });
      const result = await reader.observe(lockRecord({
        ownerPid,
        bootSessionIdentity: availableIdentity(BOOT_ID_A),
        processStartIdentity: availableIdentity(PROCESS_ID_A),
      }));
      assertClosedObserve(result, 'unavailable', scenario.name);
    }
  });

  test('process identity observe: current boot differs from record => boot-session-mismatch', async () => {
    const ownerPid = 7776;
    const recorder = createCallRecorder();
    const execFile = async (file, args) => {
      recorder.record('execFile', { file, args: [...args] });
      if (file === SYSCTL_PATH) {
        assert.deepEqual(args, [...SYSCTL_ARGV]);
        return { stdout: RAW_BOOT_B };
      }
      throw makeErrno('ENOENT', 'ps-must-not-run-on-boot-mismatch');
    };
    const kill = createKillStub(() => {
      assert.fail('boot-session-mismatch must not call kill');
    }, recorder);

    const reader = createLaunchAgentProcessIdentityReaderForTest({ execFile, kill });
    const result = await reader.observe(lockRecord({
      ownerPid,
      bootSessionIdentity: availableIdentity(BOOT_ID_A),
      processStartIdentity: availableIdentity(PROCESS_ID_A),
    }));
    assertClosedObserve(result, 'boot-session-mismatch', 'boot-session-mismatch');
    assert.equal(recorder.of('kill').length, 0);
    assert.equal(recorder.of('execFile').filter((c) => c.file === PS_PATH).length, 0);
    assert.equal(recorder.of('execFile').filter((c) => c.file === SYSCTL_PATH).length, 1);
  });

  test('process identity observe: recorded identity unavailable returns unavailable before kill/ps', async () => {
    const ownerPid = 7777;
    const cases = [
      {
        name: 'boot-unavailable',
        bootSessionIdentity: unavailableIdentity(),
        processStartIdentity: availableIdentity(PROCESS_ID_A),
      },
      {
        name: 'process-start-unavailable',
        bootSessionIdentity: availableIdentity(BOOT_ID_A),
        processStartIdentity: unavailableIdentity(),
      },
      {
        name: 'both-unavailable',
        bootSessionIdentity: unavailableIdentity(),
        processStartIdentity: unavailableIdentity(),
      },
    ];

    for (const scenario of cases) {
      const recorder = createCallRecorder();
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          recorder.record('execFile', { file, args: [...args] });
          throw makeErrno('ENOENT', 'must-not-exec');
        },
        kill: createKillStub(() => {
          assert.fail(`${scenario.name}: must not kill`);
        }, recorder),
      });
      const result = await reader.observe(lockRecord({
        ownerPid,
        bootSessionIdentity: scenario.bootSessionIdentity,
        processStartIdentity: scenario.processStartIdentity,
      }));
      assertClosedObserve(result, 'unavailable', scenario.name);
      assert.equal(recorder.of('kill').length, 0, `${scenario.name}: no kill`);
      assert.equal(recorder.of('execFile').length, 0, `${scenario.name}: no execFile`);
    }
  });

  test('process identity observe: malformed ownerPid or identity shape returns closed unavailable not raw failure', async () => {
    const recorderBase = createCallRecorder();
    const good = lockRecord({ ownerPid: 8881 });
    const malformed = [
      { name: 'null-input', input: null },
      { name: 'undefined-input', input: undefined },
      { name: 'string-input', input: 'lock' },
      { name: 'array-input', input: [] },
      { name: 'ownerPid-zero', input: lockRecord({ ownerPid: 0 }) },
      { name: 'ownerPid-negative', input: lockRecord({ ownerPid: -1 }) },
      { name: 'ownerPid-float', input: lockRecord({ ownerPid: 1.5 }) },
      { name: 'ownerPid-unsafe', input: lockRecord({ ownerPid: Number.MAX_SAFE_INTEGER + 1 }) },
      { name: 'ownerPid-string', input: lockRecord({ ownerPid: '4242' }) },
      {
        name: 'boot-missing-keys',
        input: lockRecord({
          bootSessionIdentity: { available: true },
        }),
      },
      {
        name: 'boot-available-false-with-value',
        input: lockRecord({
          bootSessionIdentity: { available: false, value: BOOT_ID_A },
        }),
      },
      {
        name: 'boot-available-true-null-value',
        input: lockRecord({
          bootSessionIdentity: { available: true, value: null },
        }),
      },
      {
        name: 'boot-available-true-empty',
        input: lockRecord({
          bootSessionIdentity: { available: true, value: '' },
        }),
      },
      {
        name: 'boot-available-not-bool',
        input: lockRecord({
          bootSessionIdentity: { available: 'yes', value: BOOT_ID_A },
        }),
      },
      {
        name: 'process-start-number-value',
        input: lockRecord({
          processStartIdentity: { available: true, value: 1 },
        }),
      },
      {
        name: 'missing-ownerPid',
        input: {
          bootSessionIdentity: availableIdentity(BOOT_ID_A),
          processStartIdentity: availableIdentity(PROCESS_ID_A),
        },
      },
    ];

    for (const scenario of malformed) {
      const recorder = createCallRecorder();
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          recorder.record('execFile', { file, args: [...args] });
          throw makeErrno('ENOENT', CANARY_ERROR);
        },
        kill: createKillStub(() => {
          throw makeErrno('ESRCH', CANARY_ERROR);
        }, recorder),
      });

      let threw = null;
      let result;
      try {
        result = await reader.observe(scenario.input);
      } catch (error) {
        threw = error;
      }
      assert.equal(threw, null, `${scenario.name}: must not throw raw failure`);
      assertClosedObserve(result, 'unavailable', scenario.name);
      assert.equal(recorder.of('kill').length, 0, `${scenario.name}: no kill`);
      assert.equal(recorder.of('execFile').length, 0, `${scenario.name}: no exec`);
    }

    // sanity：对照 good 记录仍可走通，防止 helper 自废
    void good;
    void recorderBase;
  });

  test('process identity observe: accessor Proxy and raw thrown errors normalize to unavailable without leakage', async () => {
    const ownerPid = 9001;
    const recorder = createCallRecorder();

    // 1) lockRecord 字段 accessor 抛错
    const hostileLock = {
      ownerPid,
      get bootSessionIdentity() {
        throw new Error(`${CANARY_ERROR} accessor-boot ${CANARY_PATH}`);
      },
      processStartIdentity: availableIdentity(PROCESS_ID_A),
    };
    {
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          recorder.record('execFile', { file, args: [...args] });
          throw makeErrno('ENOENT', CANARY_ERROR);
        },
        kill: createKillStub(() => {
          throw makeErrno('ESRCH', CANARY_ERROR);
        }, recorder),
      });
      const result = await reader.observe(hostileLock);
      assertClosedObserve(result, 'unavailable', 'accessor-boot');
    }

    // 2) Proxy get trap 抛错
    {
      const target = lockRecord({ ownerPid });
      const proxy = new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === 'processStartIdentity') {
            throw new Error(`${CANARY_ERROR} proxy-trap ${CANARY_STDOUT}`);
          }
          return Reflect.get(t, prop, receiver);
        },
      });
      const local = createCallRecorder();
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          local.record('execFile', { file, args: [...args] });
          return { stdout: RAW_BOOT_A };
        },
        kill: createKillStub(() => undefined, local),
      });
      const result = await reader.observe(proxy);
      assertClosedObserve(result, 'unavailable', 'proxy-trap');
    }

    // 3) execFile 抛带 canary 的原始 Error → observe 闭合 unavailable
    {
      const local = createCallRecorder();
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          local.record('execFile', { file, args: [...args] });
          if (file === SYSCTL_PATH) {
            throw new Error(`${CANARY_ERROR} ${CANARY_DATE} ${CANARY_PATH}\n${CANARY_STDOUT}`);
          }
          return { stdout: RAW_LSTART_A };
        },
        kill: createKillStub(() => undefined, local),
      });
      const result = await reader.observe(lockRecord({ ownerPid }));
      assertClosedObserve(result, 'unavailable', 'raw-exec-throw');
    }

    // 4) kill 抛非 Error 值
    {
      const local = createCallRecorder();
      const reader = createLaunchAgentProcessIdentityReaderForTest({
        execFile: async (file, args) => {
          local.record('execFile', { file, args: [...args] });
          if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
          return { stdout: RAW_LSTART_A };
        },
        kill: createKillStub(() => {
          throw `${CANARY_ERROR}-string-throw`;
        }, local),
      });
      const result = await reader.observe(lockRecord({ ownerPid }));
      assertClosedObserve(result, 'unavailable', 'kill-string-throw');
    }
  });

  test('process identity observe results are detached frozen closed objects with only status', async () => {
    const ownerPid = 9100;
    const recorder = createCallRecorder();
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile: async (file) => {
        recorder.record('execFile', { file });
        if (file === SYSCTL_PATH) return { stdout: RAW_BOOT_A };
        return { stdout: RAW_LSTART_A };
      },
      kill: createKillStub(() => undefined, recorder),
    });
    const a = await reader.observe(lockRecord({ ownerPid }));
    const b = await reader.observe(lockRecord({ ownerPid }));
    assertClosedObserve(a, 'alive-same-owner', 'a');
    assertClosedObserve(b, 'alive-same-owner', 'b');
    assert.notEqual(a, b, 'each observe() must return a detached object');
    assert.throws(() => {
      a.extra = true;
    }, TypeError);
    assert.equal(Object.hasOwn(a, 'extra'), false);
    assert.equal(Object.hasOwn(b, 'extra'), false);
  });

  test('process identity observe uses exact production command paths for boot and process-start', async () => {
    const ownerPid = 9200;
    const recorder = createCallRecorder();
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile: async (file, args, options) => {
        recorder.record('execFile', { file, args: [...args], options });
        if (file === SYSCTL_PATH) {
          assert.deepEqual(args, ['-n', 'kern.boottime']);
          return { stdout: RAW_BOOT_A };
        }
        if (file === PS_PATH) {
          assert.deepEqual(args, ['-p', String(ownerPid), '-o', 'lstart=']);
          return { stdout: RAW_LSTART_A };
        }
        throw makeErrno('ENOENT', `unexpected ${file}`);
      },
      kill: createKillStub((pid, signal) => {
        assert.equal(pid, ownerPid);
        assert.equal(signal, 0);
      }, recorder),
    });
    const result = await reader.observe(lockRecord({ ownerPid }));
    assertClosedObserve(result, 'alive-same-owner', 'command-contract');
    const files = recorder.of('execFile').map((c) => c.file);
    assert.deepEqual(files.includes(SYSCTL_PATH), true);
    assert.deepEqual(files.includes(PS_PATH), true);
    assert.equal(files.includes('/bin/sh'), false);
    assert.equal(files.includes('/usr/bin/env'), false);
  });

  test('process identity current and observe never leak raw stdout into thrown errors', async () => {
    const recorder = createCallRecorder();
    const reader = createLaunchAgentProcessIdentityReaderForTest({
      execFile: async (file) => {
        recorder.record('execFile', { file });
        const err = new Error(`fail ${CANARY_STDOUT} ${CANARY_DATE}`);
        err.code = 'EIO';
        err.stdout = CANARY_STDOUT;
        err.stderr = CANARY_STDERR;
        throw err;
      },
      kill: createKillStub(() => {
        throw makeErrno('EPERM', `${CANARY_ERROR} ${CANARY_PATH}`);
      }, recorder),
    });

    const snapshot = await reader.current();
    assertNoLeakage(snapshot, DEFAULT_CANARIES, 'current fail-closed');

    const observed = await reader.observe(lockRecord({
      ownerPid: 9300,
      bootSessionIdentity: availableIdentity(BOOT_ID_A),
      processStartIdentity: availableIdentity(PROCESS_ID_A),
    }));
    assertClosedObserve(observed, 'unavailable', 'observe fail-closed');
  });
}

// =============================================================================
// Task 2 RED — recovery lock primitive / transaction observation / recovery claim
// Fail only because the three metadata methods are absent (not import/syntax).
// Methods must be invoked only inside these selected test bodies.
// =============================================================================

const TX_LEAF = 'transaction.lock';
const MIR_LEAF = 'manual-intervention.lock';
const CLAIM_LEAF = 'recovery-claim.lock';

/** Literal valid canonical v4 UUIDs (distinct claimId / transactionId / nonces). */
const RECOV_TX_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const RECOV_TX_ID_B = 'b2c3d4e5-f6a7-4890-9bcd-ef0123456789';
const RECOV_OLD_NONCE = 'd4e5f6a7-b8c9-4a12-bdef-012345678901';
const RECOV_FRESH_NONCE = 'e5f6a7b8-c9d0-4b23-8ef0-123456789012';
const RECOV_MIR_NONCE = 'a7b8c9d0-e1f2-4d45-8012-345678901234';
const RECOV_CLAIM_ID = 'b8c9d0e1-f2a3-4e56-8123-456789012345';
const RECOV_CLAIM_ID_B = 'c9d0e1f2-a3b4-4f67-8234-567890123456';
const RECOV_FRESH_NONCE_B = 'f0a1b2c3-d4e5-4012-89ab-678901234567';
const RECOV_OWNER_PID_OLD = 4242;
const RECOV_OWNER_PID_FRESH = 5252;
const RECOV_OWNER_PID_MIR = 6262;
const RECOV_OWNER_PID_LOSER = 7272;

const BOOT_ID_LITERAL = 'opaque-boot-session-identity-v1';
const PROCESS_ID_LITERAL = 'opaque-process-start-identity-v1';
const BOOT_ID_LITERAL_B = 'opaque-boot-session-identity-v2';
const PROCESS_ID_LITERAL_B = 'opaque-process-start-identity-v2';

assert.notEqual(RECOV_CLAIM_ID, RECOV_TX_ID);
assert.notEqual(RECOV_CLAIM_ID, RECOV_FRESH_NONCE);
assert.notEqual(RECOV_CLAIM_ID, RECOV_OLD_NONCE);
assert.notEqual(RECOV_TX_ID, RECOV_FRESH_NONCE);
assert.notEqual(RECOV_TX_ID, RECOV_OLD_NONCE);
assert.notEqual(RECOV_FRESH_NONCE, RECOV_MIR_NONCE);
assert.notEqual(RECOV_TX_ID, RECOV_TX_ID_B);
assert.notEqual(RECOV_TX_ID_B, RECOV_FRESH_NONCE);
assert.notEqual(RECOV_TX_ID_B, RECOV_OLD_NONCE);
assert.notEqual(RECOV_TX_ID_B, RECOV_MIR_NONCE);
assert.notEqual(RECOV_TX_ID_B, RECOV_CLAIM_ID);

function recoverySha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recoveryAvailableIdentity(value) {
  return { available: true, value };
}

function recoveryLockRecord({
  transactionId = RECOV_TX_ID,
  ownerPid = RECOV_OWNER_PID_OLD,
  ownerNonce = RECOV_OLD_NONCE,
  bootSessionIdentity = recoveryAvailableIdentity(BOOT_ID_LITERAL),
  processStartIdentity = recoveryAvailableIdentity(PROCESS_ID_LITERAL),
} = {}) {
  return {
    schemaVersion: 1,
    transactionId,
    ownerPid,
    ownerNonce,
    bootSessionIdentity,
    processStartIdentity,
  };
}

/** Independent boundary oracle: UTF-8 JSON.stringify of exact projected key order. */
function lockRecordCanonicalBytes(record) {
  return Buffer.from(JSON.stringify({
    schemaVersion: record.schemaVersion,
    transactionId: record.transactionId,
    ownerPid: record.ownerPid,
    ownerNonce: record.ownerNonce,
    bootSessionIdentity: {
      available: record.bootSessionIdentity.available,
      value: record.bootSessionIdentity.value,
    },
    processStartIdentity: {
      available: record.processStartIdentity.available,
      value: record.processStartIdentity.value,
    },
  }), 'utf8');
}

function lockRefFromRecord(kind, record) {
  const bytes = lockRecordCanonicalBytes(record);
  return {
    kind,
    transactionId: record.transactionId,
    ownerNonce: record.ownerNonce,
    sha256: recoverySha256Hex(bytes),
  };
}

function claimRecordExact({
  claimId = RECOV_CLAIM_ID,
  transactionId = RECOV_TX_ID,
  ownerPid = RECOV_OWNER_PID_FRESH,
  ownerNonce = RECOV_FRESH_NONCE,
  bootSessionIdentity = recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
  processStartIdentity = recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  expectedTransactionLockRef,
  manualInterventionLockRef,
  freshTransactionLockRef,
}) {
  return {
    schemaVersion: 1,
    kind: 'recovery-claim-lock',
    claimId,
    transactionId,
    ownerPid,
    ownerNonce,
    bootSessionIdentity,
    processStartIdentity,
    expectedTransactionLockRef,
    manualInterventionLockRef,
    freshTransactionLockRef,
  };
}

function claimRecordCanonicalBytes(record) {
  return Buffer.from(JSON.stringify({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    claimId: record.claimId,
    transactionId: record.transactionId,
    ownerPid: record.ownerPid,
    ownerNonce: record.ownerNonce,
    bootSessionIdentity: {
      available: record.bootSessionIdentity.available,
      value: record.bootSessionIdentity.value,
    },
    processStartIdentity: {
      available: record.processStartIdentity.available,
      value: record.processStartIdentity.value,
    },
    expectedTransactionLockRef: record.expectedTransactionLockRef === null
      ? null
      : {
        kind: record.expectedTransactionLockRef.kind,
        transactionId: record.expectedTransactionLockRef.transactionId,
        ownerNonce: record.expectedTransactionLockRef.ownerNonce,
        sha256: record.expectedTransactionLockRef.sha256,
      },
    manualInterventionLockRef: {
      kind: record.manualInterventionLockRef.kind,
      transactionId: record.manualInterventionLockRef.transactionId,
      ownerNonce: record.manualInterventionLockRef.ownerNonce,
      sha256: record.manualInterventionLockRef.sha256,
    },
    freshTransactionLockRef: {
      kind: record.freshTransactionLockRef.kind,
      transactionId: record.freshTransactionLockRef.transactionId,
      ownerNonce: record.freshTransactionLockRef.ownerNonce,
      sha256: record.freshTransactionLockRef.sha256,
    },
  }), 'utf8');
}

function claimRefFromRecord(record) {
  const bytes = claimRecordCanonicalBytes(record);
  return {
    kind: 'recovery-claim-lock',
    claimId: record.claimId,
    transactionId: record.transactionId,
    ownerNonce: record.ownerNonce,
    sha256: recoverySha256Hex(bytes),
  };
}

function assertDeeplyFrozenValue(value, location = 'value') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${location} must be frozen`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      assertDeeplyFrozenValue(descriptor.value, `${location}.${String(key)}`);
    }
  }
}

function assertExactObjectKeys(value, expectedKeys, location = 'value') {
  assert.equal(value === null || typeof value !== 'object', false, `${location} must be object`);
  const keys = Reflect.ownKeys(value)
    .filter((k) => typeof k === 'string')
    .sort();
  assert.deepEqual(keys, [...expectedKeys].sort(), `${location} exact keys`);
}

function isTransactionInProgressError(error) {
  return (
    error instanceof LaunchAgentLifecycleError
    && error.code === LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS
    && error.message === LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS
  );
}

function isLifecycleError(error) {
  return error instanceof LaunchAgentLifecycleError;
}

function isInvalidLifecycleError(error) {
  return (
    error instanceof LaunchAgentLifecycleError
    && error.code === LAUNCHAGENT_LIFECYCLE_CODES.INVALID
    && error.message === LAUNCHAGENT_LIFECYCLE_CODES.INVALID
  );
}

/** Short test-side bound for claim-held / barrier waits — fail assertively, never hang. */
const RECOVERY_BARRIER_TIMEOUT_MS = 2000;

/**
 * Deterministic test barrier with an explicit timeout.
 * Missing durability events or wrong artifact names must fail quickly, not hang.
 */
function createRecoveryBarrier(label) {
  let resolveFn = null;
  let settled = false;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    signal() {
      if (settled) return;
      settled = true;
      resolveFn();
    },
    async wait(timeoutMs = RECOVERY_BARRIER_TIMEOUT_MS) {
      let timer = null;
      try {
        await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new assert.AssertionError({
                message: `barrier timeout after ${timeoutMs}ms: ${label}`,
              }));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
    get settled() {
      return settled;
    },
  };
}

function pathBaseName(pathLike) {
  if (typeof pathLike !== 'string') return '';
  return basename(pathLike);
}

function openFlagsNumber(flags) {
  if (typeof flags === 'number') return flags;
  return null;
}

function isExclWriteOpenFlags(flags) {
  const n = openFlagsNumber(flags);
  if (n === null) return false;
  const creat = fsConstants.O_CREAT;
  const excl = fsConstants.O_EXCL;
  return (n & creat) === creat && (n & excl) === excl;
}

function isReadOnlyOpenFlags(flags) {
  const n = openFlagsNumber(flags);
  if (n === null) {
    return flags === 'r' || flags === 'rs' || flags === 'sr';
  }
  const creat = fsConstants.O_CREAT;
  const wronly = fsConstants.O_WRONLY;
  const rdwr = fsConstants.O_RDWR;
  const append = fsConstants.O_APPEND;
  const trunc = fsConstants.O_TRUNC;
  if ((n & creat) === creat) return false;
  if ((n & wronly) === wronly) return false;
  if ((n & rdwr) === rdwr) return false;
  if ((n & append) === append) return false;
  if ((n & trunc) === trunc) return false;
  return true;
}

/**
 * Count only transaction.lock pathname mutations: unlink or O_CREAT|O_EXCL write-open.
 * Read-only descriptor opens are allowed and are not mutation.
 * When pauseBeforeTxMutation is set, after durable claim verify the first post-claim
 * open/unlink of transaction.lock pauses before proceeding (covers revalidation + mutation).
 * Pause is winner-only via `fs` (pausing view); concurrent losers must use `fsShared`
 * (shared mutation counting, no pause) so their pre-claim transaction.lock revalidation
 * can proceed to claim O_EXCL without deadlocking on the winner pause gate.
 * Injects only through existing ForTest fs wrapper / durability coordination — no production hooks.
 */
function createTransactionMutationCounter(metadataRoot, options = {}) {
  const txPath = join(metadataRoot, TX_LEAF);
  const claimPath = join(metadataRoot, CLAIM_LEAF);
  const mutations = [];
  const allOpens = [];
  const pauseBeforeTxMutation = options.pauseBeforeTxMutation === true;
  let pauseResolve = null;
  const pauseGate = pauseBeforeTxMutation
    ? new Promise((resolve) => {
      pauseResolve = resolve;
    })
    : null;
  let claimVerifySeen = false;
  let released = !pauseBeforeTxMutation;
  const onClaimVerify = typeof options.onClaimVerify === 'function'
    ? options.onClaimVerify
    : null;
  const injectErrorAfterClaim = options.injectErrorAfterClaim === true;
  let errorInjected = false;

  async function pauseAfterClaimBeforeTxWork() {
    if (pauseBeforeTxMutation && claimVerifySeen && !released) {
      await pauseGate;
    }
  }

  async function maybeCountAndInject(kind, path, flags) {
    if (kind === 'open-excl' || kind === 'unlink') {
      mutations.push({ kind, path, flags });
      if (injectErrorAfterClaim && claimVerifySeen && !errorInjected) {
        errorInjected = true;
        const err = new Error(
          kind === 'unlink'
            ? 'injected-after-claim-on-old-unlink'
            : 'injected-after-claim-before-fresh-tx',
        );
        err.code = 'EIO';
        throw err;
      }
    }
  }

  function createWrappedFs({ allowPause }) {
    return new Proxy(fsPromises, {
      get(target, property, receiver) {
        if (property === 'open') {
          return async (path, flags, mode) => {
            const leaf = pathBaseName(path);
            allOpens.push({ path, flags, leaf });
            if (leaf === TX_LEAF) {
              // Winner-only pause before post-claim revalidation open or exclusive write-open.
              if (allowPause) {
                await pauseAfterClaimBeforeTxWork();
              }
              if (isExclWriteOpenFlags(flags)) {
                await maybeCountAndInject('open-excl', path, flags);
              }
            }
            return target.open(path, flags, mode);
          };
        }
        if (property === 'unlink') {
          return async (path) => {
            const leaf = pathBaseName(path);
            if (leaf === TX_LEAF) {
              if (allowPause) {
                await pauseAfterClaimBeforeTxWork();
              }
              await maybeCountAndInject('unlink', path, null);
            }
            return target.unlink(path);
          };
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function') {
          return value.bind(target);
        }
        return value;
      },
    });
  }

  return {
    // Pausing view: post-claim transaction.lock work waits on the winner gate.
    fs: createWrappedFs({ allowPause: true }),
    // Shared-counting, non-pausing view: loser may revalidate/read and attempt claim
    // without parking on the winner's pause gate; mutations still share `mutations`.
    fsShared: createWrappedFs({ allowPause: false }),
    mutations,
    allOpens,
    claimPath,
    txPath,
    markClaimVerified() {
      claimVerifySeen = true;
      if (typeof onClaimVerify === 'function') onClaimVerify();
    },
    releasePause() {
      released = true;
      if (pauseResolve) pauseResolve();
    },
    get claimVerifySeen() {
      return claimVerifySeen;
    },
    transactionMutationCount() {
      return mutations.length;
    },
  };
}

async function makeRecoveryTempRoot(t) {
  const container = await mkdtemp(join(tmpdir(), 'linke-la-recov-'));
  t.after(async () => {
    await rm(container, { recursive: true, force: true });
  });
  return join(container, 'metadata');
}

function requireMetadataFactory(name) {
  const factory = metadataStoreModule[name];
  assert.equal(typeof factory, 'function', `expected ${name} export`);
  return factory;
}

async function plantOwnedLeaf(metadataRoot, leafName, bytes) {
  const leafPath = join(metadataRoot, leafName);
  await writeFile(leafPath, bytes, { mode: 0o600 });
  const st = await lstat(leafPath);
  assert.equal(st.isFile(), true);
  assert.equal(st.mode & 0o777, 0o600);
  return leafPath;
}

async function setupMirHeldTransaction(store, {
  oldRecord = recoveryLockRecord(),
  mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  }),
} = {}) {
  const txRef = await store.acquireTransactionLock(oldRecord);
  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  return { oldRecord, mirRecord, txRef, mirRef };
}

/**
 * Require only the single public method this test body actually exercises.
 * Method-absence RED must distribute across the three missing methods;
 * do not mask all failures behind the first of a multi-method probe.
 */
function requireRecoveryMethod(store, name, message) {
  assert.equal(
    typeof store[name],
    'function',
    message ?? `production bug: store.${name} must exist`,
  );
}

// ---------------------------------------------------------------------------
// Absence + frozen observation surfaces
// ---------------------------------------------------------------------------

test('transaction lock observation returns null without mutation when transaction.lock is absent', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const mutations = [];
  const store = createForTest({
    metadataRoot,
    fs: new Proxy(fsPromises, {
      get(target, property, receiver) {
        if (property === 'open') {
          return async (path, flags, mode) => {
            if (isExclWriteOpenFlags(flags)) mutations.push('fs.open-excl');
            return target.open(path, flags, mode);
          };
        }
        if (property === 'unlink' || property === 'writeFile' || property === 'rename') {
          return async (...args) => {
            mutations.push(`fs.${String(property)}`);
            return target[property](...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    }),
    onDurabilityEvent: () => {},
  });
  await store.initialize();
  mutations.length = 0;

  requireRecoveryMethod(
    store,
    'readTransactionLockObservation',
    'production bug: store.readTransactionLockObservation must exist for transaction lock observation',
  );
  const before = await fsPromises.readdir(metadataRoot);
  const observation = await store.readTransactionLockObservation();
  assert.equal(
    observation,
    null,
    'production bug: absent transaction.lock must yield null observation without inventing a lock',
  );
  const after = await fsPromises.readdir(metadataRoot);
  assert.deepEqual(after, before, 'absence observation must not mutate metadata root listing');
  assert.equal(mutations.length, 0, 'absence observation must not perform write mutations');
  await assert.rejects(
    () => access(join(metadataRoot, TX_LEAF)),
    (error) => error && error.code === 'ENOENT',
  );
});

test('recovery claim observation returns null without mutation when recovery-claim.lock is absent', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const mutations = [];
  const store = createForTest({
    metadataRoot,
    fs: new Proxy(fsPromises, {
      get(target, property, receiver) {
        if (property === 'unlink' || property === 'writeFile' || property === 'rename') {
          return async (...args) => {
            mutations.push(String(property));
            return target[property](...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    }),
    onDurabilityEvent: () => {},
  });
  await store.initialize();
  mutations.length = 0;
  requireRecoveryMethod(
    store,
    'readRecoveryClaimObservation',
    'production bug: store.readRecoveryClaimObservation must exist for recovery claim observation',
  );
  const observation = await store.readRecoveryClaimObservation();
  assert.equal(
    observation,
    null,
    'production bug: absent recovery-claim.lock must yield null without creating a claim',
  );
  assert.equal(mutations.length, 0, 'claim absence observation must not mutate leaves');
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
  );
});

test('transaction lock observation returns exact detached deeply frozen observation and ref', async (t) => {
  const createStore = requireMetadataFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const store = createStore({ metadataRoot });
  await store.initialize();

  const record = recoveryLockRecord();
  const expectedBytes = lockRecordCanonicalBytes(record);
  const expectedRef = lockRefFromRecord('transaction-lock', record);
  await store.acquireTransactionLock(record);
  const onDisk = await readFile(join(metadataRoot, TX_LEAF));
  assert.equal(Buffer.compare(onDisk, expectedBytes), 0, 'precondition: canonical lock bytes');
  assert.equal(recoverySha256Hex(onDisk), expectedRef.sha256);

  requireRecoveryMethod(
    store,
    'readTransactionLockObservation',
    'production bug: store.readTransactionLockObservation must exist for transaction lock observation',
  );
  const observation = await store.readTransactionLockObservation();
  assert.equal(
    observation === null,
    false,
    'production bug: existing transaction.lock must return observation not null',
  );
  assertExactObjectKeys(observation, ['kind', 'ref', 'record'], 'transaction observation');
  assert.equal(observation.kind, 'transaction-lock-observation');
  assert.deepEqual(observation.ref, expectedRef);
  assert.deepEqual(observation.record, record);
  assertDeeplyFrozenValue(observation, 'transaction observation');

  // Detached: mutate returned surfaces must not alter later rereads / on-disk bytes.
  assert.throws(() => {
    observation.kind = 'mutated';
  });
  const mutatedCopy = { ...observation.record, ownerPid: 1 };
  void mutatedCopy;
  try {
    observation.record.ownerPid = 99999;
  } catch {
    // frozen may throw; either way reread must match original
  }
  try {
    observation.ref.sha256 = '0'.repeat(64);
  } catch {
    // frozen
  }

  const reread = await store.readTransactionLockObservation();
  assert.deepEqual(reread.record, record);
  assert.deepEqual(reread.ref, expectedRef);
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), expectedBytes),
    0,
    'observation mutation must not rewrite transaction.lock bytes',
  );
  assert.notEqual(reread, observation, 'each observation must be detached');
});

test('recovery claim observation returns exact detached deeply frozen claim observation and ref', async (t) => {
  const createStore = requireMetadataFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const store = createStore({ metadataRoot });
  await store.initialize();

  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const freshRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  const claim = claimRecordExact({
    expectedTransactionLockRef: txRef,
    manualInterventionLockRef: mirRef,
    freshTransactionLockRef: lockRefFromRecord('transaction-lock', freshRecord),
  });
  const claimBytes = claimRecordCanonicalBytes(claim);
  const expectedClaimRef = claimRefFromRecord(claim);
  await plantOwnedLeaf(metadataRoot, CLAIM_LEAF, claimBytes);
  assert.equal(recoverySha256Hex(claimBytes), expectedClaimRef.sha256);

  requireRecoveryMethod(
    store,
    'readRecoveryClaimObservation',
    'production bug: store.readRecoveryClaimObservation must exist for recovery claim observation',
  );
  const observation = await store.readRecoveryClaimObservation();
  assert.equal(observation === null, false, 'production bug: existing claim must be observed');
  assertExactObjectKeys(observation, ['kind', 'ref', 'record'], 'claim observation');
  assert.equal(observation.kind, 'recovery-claim-observation');
  assert.deepEqual(observation.ref, expectedClaimRef);
  assert.deepEqual(observation.record, claim);
  assertDeeplyFrozenValue(observation, 'claim observation');

  try {
    observation.record.claimId = RECOV_CLAIM_ID_B;
  } catch {
    // frozen
  }
  const reread = await store.readRecoveryClaimObservation();
  assert.deepEqual(reread.record, claim);
  assert.deepEqual(reread.ref, expectedClaimRef);
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, CLAIM_LEAF)), claimBytes),
    0,
    'claim observation mutation must not rewrite recovery-claim.lock',
  );
});

// ---------------------------------------------------------------------------
// acquireRecoveryLockForManualRepair — prechecks, race, durability, crash, stale
// ---------------------------------------------------------------------------

test('recovery lock primitive rejects MIR mismatch before any transaction mutation', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const counter = createTransactionMutationCounter(metadataRoot);
  const store = createForTest({
    metadataRoot,
    fs: counter.fs,
    onDurabilityEvent: () => {},
  });
  await store.initialize();

  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const wrongMirRef = {
    kind: 'manual-intervention-lock',
    transactionId: RECOV_TX_ID,
    ownerNonce: RECOV_MIR_NONCE,
    sha256: '0'.repeat(64),
  };
  const freshRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
  const beforeMir = await readFile(join(metadataRoot, MIR_LEAF));
  counter.mutations.length = 0;

  requireRecoveryMethod(
    store,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  await assert.rejects(
    () => store.acquireRecoveryLockForManualRepair({
      record: freshRecord,
      claimId: RECOV_CLAIM_ID,
      expectedTransactionLockRef: txRef,
      manualInterventionLockRef: wrongMirRef,
    }),
    (error) => isLifecycleError(error),
    'production bug: MIR ref mismatch must fail closed before transaction mutation',
  );
  assert.equal(
    counter.transactionMutationCount(),
    0,
    'MIR mismatch must not unlink/open-excl transaction.lock',
  );
  assert.equal(Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx), 0);
  assert.equal(Buffer.compare(await readFile(join(metadataRoot, MIR_LEAF)), beforeMir), 0);
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
    'MIR mismatch must not publish recovery-claim.lock',
  );
});

/**
 * Task 2 RED — cross-transaction binding: acquisition must bind both
 * expectedTransactionLockRef.transactionId and manualInterventionLockRef.transactionId
 * to fresh record.transactionId before any claim O_EXCL or transaction mutation.
 * Plant canonical owned leaves so each mismatch is isolated (setup helpers require same TX).
 */
test('recovery lock primitive rejects cross-transaction expected/MIR refs before claim mutation', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');

  await t.test('expected-ref cross-transaction mismatch only: exact INVALID before claim/tx mutation', async (st) => {
    // Disk TX + expected ref = A; disk MIR/ref + fresh record = B.
    const metadataRoot = await makeRecoveryTempRoot(st);
    const counter = createTransactionMutationCounter(metadataRoot);
    const store = createForTest({
      metadataRoot,
      fs: counter.fs,
      onDurabilityEvent: () => {},
    });
    await store.initialize();

    const txARecord = recoveryLockRecord({
      transactionId: RECOV_TX_ID,
      ownerPid: RECOV_OWNER_PID_OLD,
      ownerNonce: RECOV_OLD_NONCE,
    });
    const mirBRecord = recoveryLockRecord({
      transactionId: RECOV_TX_ID_B,
      ownerPid: RECOV_OWNER_PID_MIR,
      ownerNonce: RECOV_MIR_NONCE,
    });
    const txABytes = lockRecordCanonicalBytes(txARecord);
    const mirBBytes = lockRecordCanonicalBytes(mirBRecord);
    const expectedTxARef = lockRefFromRecord('transaction-lock', txARecord);
    const mirBRef = lockRefFromRecord('manual-intervention-lock', mirBRecord);
    await plantOwnedLeaf(metadataRoot, TX_LEAF, txABytes);
    await plantOwnedLeaf(metadataRoot, MIR_LEAF, mirBBytes);

    const freshBRecord = recoveryLockRecord({
      transactionId: RECOV_TX_ID_B,
      ownerPid: RECOV_OWNER_PID_FRESH,
      ownerNonce: RECOV_FRESH_NONCE,
      bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
      processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
    });
    const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
    const beforeMir = await readFile(join(metadataRoot, MIR_LEAF));
    assert.equal(Buffer.compare(beforeTx, txABytes), 0);
    assert.equal(Buffer.compare(beforeMir, mirBBytes), 0);
    counter.mutations.length = 0;
    counter.allOpens.length = 0;

    requireRecoveryMethod(
      store,
      'acquireRecoveryLockForManualRepair',
      'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
    );
    await assert.rejects(
      () => store.acquireRecoveryLockForManualRepair({
        record: freshBRecord,
        claimId: RECOV_CLAIM_ID,
        expectedTransactionLockRef: expectedTxARef,
        manualInterventionLockRef: mirBRef,
      }),
      (error) => isInvalidLifecycleError(error),
      'production bug: expected-ref.transactionId must bind to fresh record.transactionId (cross-tx A vs B)',
    );
    assert.equal(
      counter.transactionMutationCount(),
      0,
      'expected-ref cross-tx must not unlink/open-excl transaction.lock',
    );
    assert.equal(
      counter.allOpens.some((o) => o.leaf === CLAIM_LEAF && isExclWriteOpenFlags(o.flags)),
      false,
      'expected-ref cross-tx must not O_EXCL open recovery-claim.lock',
    );
    assert.equal(Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx), 0);
    assert.equal(Buffer.compare(await readFile(join(metadataRoot, MIR_LEAF)), beforeMir), 0);
    await assert.rejects(
      () => access(join(metadataRoot, CLAIM_LEAF)),
      (error) => error && error.code === 'ENOENT',
      'expected-ref cross-tx must leave recovery-claim.lock absent',
    );
  });

  await t.test('MIR-ref cross-transaction mismatch only: exact INVALID before claim/tx mutation', async (st) => {
    // Disk TX/expected ref + fresh record = B; disk MIR/ref = A.
    const metadataRoot = await makeRecoveryTempRoot(st);
    const counter = createTransactionMutationCounter(metadataRoot);
    const store = createForTest({
      metadataRoot,
      fs: counter.fs,
      onDurabilityEvent: () => {},
    });
    await store.initialize();

    const txBRecord = recoveryLockRecord({
      transactionId: RECOV_TX_ID_B,
      ownerPid: RECOV_OWNER_PID_OLD,
      ownerNonce: RECOV_OLD_NONCE,
    });
    const mirARecord = recoveryLockRecord({
      transactionId: RECOV_TX_ID,
      ownerPid: RECOV_OWNER_PID_MIR,
      ownerNonce: RECOV_MIR_NONCE,
    });
    const txBBytes = lockRecordCanonicalBytes(txBRecord);
    const mirABytes = lockRecordCanonicalBytes(mirARecord);
    const expectedTxBRef = lockRefFromRecord('transaction-lock', txBRecord);
    const mirARef = lockRefFromRecord('manual-intervention-lock', mirARecord);
    await plantOwnedLeaf(metadataRoot, TX_LEAF, txBBytes);
    await plantOwnedLeaf(metadataRoot, MIR_LEAF, mirABytes);

    const freshBRecord = recoveryLockRecord({
      transactionId: RECOV_TX_ID_B,
      ownerPid: RECOV_OWNER_PID_FRESH,
      ownerNonce: RECOV_FRESH_NONCE,
      bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
      processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
    });
    const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
    const beforeMir = await readFile(join(metadataRoot, MIR_LEAF));
    assert.equal(Buffer.compare(beforeTx, txBBytes), 0);
    assert.equal(Buffer.compare(beforeMir, mirABytes), 0);
    counter.mutations.length = 0;
    counter.allOpens.length = 0;

    requireRecoveryMethod(
      store,
      'acquireRecoveryLockForManualRepair',
      'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
    );
    await assert.rejects(
      () => store.acquireRecoveryLockForManualRepair({
        record: freshBRecord,
        claimId: RECOV_CLAIM_ID,
        expectedTransactionLockRef: expectedTxBRef,
        manualInterventionLockRef: mirARef,
      }),
      (error) => isInvalidLifecycleError(error),
      'production bug: MIR-ref.transactionId must bind to fresh record.transactionId (cross-tx A vs B)',
    );
    assert.equal(
      counter.transactionMutationCount(),
      0,
      'MIR-ref cross-tx must not unlink/open-excl transaction.lock',
    );
    assert.equal(
      counter.allOpens.some((o) => o.leaf === CLAIM_LEAF && isExclWriteOpenFlags(o.flags)),
      false,
      'MIR-ref cross-tx must not O_EXCL open recovery-claim.lock',
    );
    assert.equal(Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx), 0);
    assert.equal(Buffer.compare(await readFile(join(metadataRoot, MIR_LEAF)), beforeMir), 0);
    await assert.rejects(
      () => access(join(metadataRoot, CLAIM_LEAF)),
      (error) => error && error.code === 'ENOENT',
      'MIR-ref cross-tx must leave recovery-claim.lock absent',
    );
  });
});

test('recovery lock primitive expectedTransactionLockRef null succeeds only when transaction.lock is exactly absent', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const events = [];
  const store = createForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  await store.initialize();

  // Case 1: transaction present + null expected → reject, zero claim
  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
  const freshRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });

  requireRecoveryMethod(
    store,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  await assert.rejects(
    () => store.acquireRecoveryLockForManualRepair({
      record: freshRecord,
      claimId: RECOV_CLAIM_ID,
      expectedTransactionLockRef: null,
      manualInterventionLockRef: mirRef,
    }),
    (error) => isLifecycleError(error),
    'production bug: expectedTransactionLockRef null must reject when transaction.lock exists',
  );
  assert.equal(Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx), 0);
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
  );

  // Case 2: exact absence + null expected → claim-fenced publish of fresh lock
  // Remove old transaction via special MIR handoff requires journal; plant by deleting
  // only when we set up a fresh root with MIR-only is invalid for ordinary acquire.
  // Use recovery path: write MIR after holding tx, then manually unlink is not production.
  // Instead: second root where we only publish MIR is INVALID for ordinary path.
  // Spec: expected null succeeds only if leaf is absent — use a root that has MIR by
  // first creating both, then (test-only) removing transaction after recording mirRef.
  await fsPromises.unlink(join(metadataRoot, TX_LEAF));
  await assert.rejects(
    () => access(join(metadataRoot, TX_LEAF)),
    (error) => error && error.code === 'ENOENT',
    'precondition: transaction.lock exactly absent',
  );
  const mirBytes = await readFile(join(metadataRoot, MIR_LEAF));
  events.length = 0;

  const freshRef = await store.acquireRecoveryLockForManualRepair({
    record: freshRecord,
    claimId: RECOV_CLAIM_ID,
    expectedTransactionLockRef: null,
    manualInterventionLockRef: mirRef,
  });
  assert.deepEqual(freshRef, lockRefFromRecord('transaction-lock', freshRecord));
  const published = await readFile(join(metadataRoot, TX_LEAF));
  assert.equal(Buffer.compare(published, lockRecordCanonicalBytes(freshRecord)), 0);
  assert.equal(Buffer.compare(await readFile(join(metadataRoot, MIR_LEAF)), mirBytes), 0);
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
    'normal success must leave no recovery-claim.lock',
  );
});

test('recovery lock primitive deterministic single-winner claim race: loser is transaction-in-progress with zero transaction mutations', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const events = [];
  const claimHeld = createRecoveryBarrier('deterministic race claim-held (recovery-claim-lock verify)');
  const counter = createTransactionMutationCounter(metadataRoot, {
    pauseBeforeTxMutation: true,
    onClaimVerify() {
      claimHeld.signal();
    },
  });
  t.after(() => {
    counter.releasePause();
  });
  const storeWinner = createForTest({
    metadataRoot,
    fs: counter.fs,
    onDurabilityEvent: (event) => {
      events.push(event);
      if (
        event
        && event.kind === 'verify'
        && event.artifact === 'recovery-claim-lock'
      ) {
        counter.markClaimVerified();
      }
    },
  });
  // Loser must share mutation counting but must NOT share the winner pause gate:
  // after claim verify, loser's required pre-claim transaction.lock revalidation
  // would otherwise park forever on pauseBeforeTxMutation.
  const storeLoser = createForTest({
    metadataRoot,
    fs: counter.fsShared,
    onDurabilityEvent: () => {},
  });
  await storeWinner.initialize();
  await storeLoser.initialize();

  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef, mirRef } = await setupMirHeldTransaction(storeWinner, { oldRecord, mirRecord });
  const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
  const beforeMir = await readFile(join(metadataRoot, MIR_LEAF));
  const winnerFresh = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  const loserFresh = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_LOSER,
    ownerNonce: RECOV_FRESH_NONCE_B,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });

  requireRecoveryMethod(
    storeWinner,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  requireRecoveryMethod(
    storeLoser,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  counter.mutations.length = 0;

  const winnerPromise = storeWinner.acquireRecoveryLockForManualRepair({
    record: winnerFresh,
    claimId: RECOV_CLAIM_ID,
    expectedTransactionLockRef: txRef,
    manualInterventionLockRef: mirRef,
  });
  t.after(async () => {
    counter.releasePause();
    try {
      await winnerPromise;
    } catch {
      // settle pending acquisition so the test harness does not hang
    }
  });

  // Deterministic barrier: wait until claim durable verify (not scheduler luck); bounded fail.
  await claimHeld.wait();
  assert.equal(counter.claimVerifySeen, true, 'winner must hold durable claim before pause');
  await access(join(metadataRoot, CLAIM_LEAF));

  const mutationsAtClaim = counter.transactionMutationCount();
  assert.equal(
    mutationsAtClaim,
    0,
    'before resume, claim-held winner must not have mutated transaction.lock yet',
  );

  await assert.rejects(
    () => storeLoser.acquireRecoveryLockForManualRepair({
      record: loserFresh,
      claimId: RECOV_CLAIM_ID_B,
      expectedTransactionLockRef: txRef,
      manualInterventionLockRef: mirRef,
    }),
    (error) => isTransactionInProgressError(error),
    'production bug: claim O_EXCL loser must map to transaction-in-progress',
  );
  assert.equal(
    counter.transactionMutationCount(),
    0,
    'claim loser must record zero transaction unlink/O_EXCL write-open (read-only opens allowed)',
  );
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx),
    0,
    'loser must not change transaction.lock bytes',
  );

  counter.releasePause();
  const winnerRef = await winnerPromise;
  assert.deepEqual(winnerRef, lockRefFromRecord('transaction-lock', winnerFresh));
  assert.equal(
    Buffer.compare(
      await readFile(join(metadataRoot, TX_LEAF)),
      lockRecordCanonicalBytes(winnerFresh),
    ),
    0,
    'exactly one O_EXCL claim winner may publish fresh transaction.lock',
  );
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, MIR_LEAF)), beforeMir),
    0,
    'MIR bytes must remain unchanged after normal winner success',
  );
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
    'winner definition: after normal completion claim is absent and fresh ref is on disk',
  );
});

test('recovery lock primitive durability order: claim sync-verify before old unlink; fresh before claim unlink', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const events = [];
  const fsOps = [];
  const claimPath = join(metadataRoot, CLAIM_LEAF);
  const wrappedFs = new Proxy(fsPromises, {
    get(target, property, receiver) {
      if (property === 'open') {
        return async (path, flags, mode) => {
          fsOps.push({ op: 'open', leaf: pathBaseName(path), flags });
          return target.open(path, flags, mode);
        };
      }
      if (property === 'unlink') {
        return async (path) => {
          fsOps.push({ op: 'unlink', leaf: pathBaseName(path) });
          return target.unlink(path);
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
  const store = createForTest({
    metadataRoot,
    fs: wrappedFs,
    onDurabilityEvent: (event) => {
      events.push(event);
      fsOps.push({ op: 'durability', kind: event.kind, artifact: event.artifact });
    },
  });
  await store.initialize();
  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const freshRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  events.length = 0;
  fsOps.length = 0;

  requireRecoveryMethod(
    store,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  await store.acquireRecoveryLockForManualRepair({
    record: freshRecord,
    claimId: RECOV_CLAIM_ID,
    expectedTransactionLockRef: txRef,
    manualInterventionLockRef: mirRef,
  });

  const claimArtifact = (event) => event.artifact === 'recovery-claim-lock';
  const claimFileSync = events.findIndex((e) => e.kind === 'file-sync' && claimArtifact(e));
  const claimDirSync = events.findIndex((e) => e.kind === 'directory-sync' && claimArtifact(e));
  const claimVerify = events.findIndex((e) => e.kind === 'verify' && claimArtifact(e));
  assert.notEqual(claimFileSync, -1, 'must emit claim file-sync for artifact recovery-claim-lock');
  assert.notEqual(claimDirSync, -1, 'must emit claim directory-sync for artifact recovery-claim-lock');
  assert.notEqual(claimVerify, -1, 'must emit claim verify for artifact recovery-claim-lock');
  assert.ok(claimFileSync < claimDirSync, 'claim file-sync before directory-sync');
  assert.ok(claimDirSync < claimVerify, 'claim directory-sync before verify');

  const firstOldUnlink = fsOps.findIndex(
    (e) => e.op === 'unlink' && e.leaf === TX_LEAF,
  );
  assert.notEqual(firstOldUnlink, -1, 'must unlink old transaction.lock');
  const claimVerifyOp = fsOps.findIndex(
    (e) => e.op === 'durability' && e.kind === 'verify' && e.artifact === 'recovery-claim-lock',
  );
  assert.ok(
    claimVerifyOp < firstOldUnlink,
    'production bug: claim file-sync → dir-sync → verify must precede old transaction unlink',
  );

  const freshExcl = fsOps.findIndex(
    (e) => e.op === 'open' && e.leaf === TX_LEAF && isExclWriteOpenFlags(e.flags),
  );
  assert.notEqual(freshExcl, -1, 'must O_EXCL publish fresh transaction.lock');
  // old unlink -> metadata-root sync before fresh durable publication
  assert.ok(firstOldUnlink < freshExcl, 'old unlink before fresh O_EXCL publication');

  const claimUnlink = fsOps.findIndex(
    (e) => e.op === 'unlink' && e.leaf === CLAIM_LEAF,
  );
  assert.notEqual(claimUnlink, -1, 'must unlink own exact claim after success path');
  const freshVerify = fsOps.findIndex(
    (e) => e.op === 'durability'
      && e.kind === 'verify'
      && e.artifact === 'transaction-lock',
  );
  assert.notEqual(freshVerify, -1, 'must verify fresh transaction lock');
  assert.ok(
    freshVerify < claimUnlink,
    'production bug: fresh/MIR/own-claim reverify before exact claim unlink',
  );

  await assert.rejects(
    () => access(claimPath),
    (error) => error && error.code === 'ENOENT',
    'root sync + claim absence before return',
  );
});

test('recovery lock primitive normal winner removes only revalidated old ref, publishes fresh O_EXCL, removes exact claim; MIR unchanged', async (t) => {
  const createStore = requireMetadataFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const store = createStore({ metadataRoot });
  await store.initialize();
  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const mirBytes = await readFile(join(metadataRoot, MIR_LEAF));
  const freshRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });

  requireRecoveryMethod(
    store,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  const freshRef = await store.acquireRecoveryLockForManualRepair({
    record: freshRecord,
    claimId: RECOV_CLAIM_ID,
    expectedTransactionLockRef: txRef,
    manualInterventionLockRef: mirRef,
  });

  assert.deepEqual(
    freshRef,
    lockRefFromRecord('transaction-lock', freshRecord),
    'return must be exact fresh transaction-lock ref (store-computed sha256)',
  );
  assert.equal(
    Buffer.compare(
      await readFile(join(metadataRoot, TX_LEAF)),
      lockRecordCanonicalBytes(freshRecord),
    ),
    0,
    'disk must hold exactly the fresh transaction lock',
  );
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, MIR_LEAF)), mirBytes),
    0,
    'MIR bytes must be unchanged',
  );
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
    'no claim after normal success',
  );
  // Caller cannot supply freshTransactionLockRef — only store-computed from record.
  assert.equal(
    freshRef.sha256,
    recoverySha256Hex(lockRecordCanonicalBytes(freshRecord)),
    'independent test-side oracle must match store-published fresh sha256',
  );
});

test('recovery lock primitive retains exact claim after injected error post claim durability', async (t) => {
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const events = [];
  const counter = createTransactionMutationCounter(metadataRoot, {
    injectErrorAfterClaim: true,
  });
  const store = createForTest({
    metadataRoot,
    fs: counter.fs,
    onDurabilityEvent: (event) => {
      events.push(event);
      if (
        event
        && event.kind === 'verify'
        && event.artifact === 'recovery-claim-lock'
      ) {
        counter.markClaimVerified();
      }
    },
  });
  await store.initialize();
  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
  const freshRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });

  requireRecoveryMethod(
    store,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  await assert.rejects(
    () => store.acquireRecoveryLockForManualRepair({
      record: freshRecord,
      claimId: RECOV_CLAIM_ID,
      expectedTransactionLockRef: txRef,
      manualInterventionLockRef: mirRef,
    }),
    (error) => isInvalidLifecycleError(error),
    'production bug: post-claim injected EIO must normalize to launchagent-lifecycle-invalid (raw EIO must not escape the store boundary)',
  );

  // production bug: any failure after durable claim leaves the exact claim in place
  // (no catch/finally cleanup may pass)
  const claimBytes = await readFile(join(metadataRoot, CLAIM_LEAF));
  const claimParsed = JSON.parse(claimBytes.toString('utf8'));
  assert.equal(claimParsed.kind, 'recovery-claim-lock');
  assert.equal(claimParsed.claimId, RECOV_CLAIM_ID);
  assert.equal(claimParsed.transactionId, RECOV_TX_ID);
  assert.equal(claimParsed.ownerNonce, RECOV_FRESH_NONCE);
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx),
    0,
    'post-claim crash must not complete transaction mutation (old lock intact or equivalent pre-fresh)',
  );
});

test('recovery lock primitive late stale post-claim residual: drift after claim retains exact claim and published winner', async (t) => {
  // Deterministic post-claim drift fixture (no soft claimExists branch):
  // contender passes initial old-ref check, durably publishes+verifies its claim,
  // pauses before transaction revalidation/mutation; while paused the test plants a
  // different published-winner on the transaction leaf; resume must fail closed.
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeRecoveryTempRoot(t);
  const claimHeld = createRecoveryBarrier('late-stale post-claim residual claim-held');
  const counter = createTransactionMutationCounter(metadataRoot, {
    pauseBeforeTxMutation: true,
    onClaimVerify() {
      claimHeld.signal();
    },
  });
  t.after(() => {
    counter.releasePause();
  });
  const store = createForTest({
    metadataRoot,
    fs: counter.fs,
    onDurabilityEvent: (event) => {
      if (
        event
        && event.kind === 'verify'
        && event.artifact === 'recovery-claim-lock'
      ) {
        counter.markClaimVerified();
      }
    },
  });
  await store.initialize();

  const oldRecord = recoveryLockRecord();
  const mirRecord = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_MIR,
    ownerNonce: RECOV_MIR_NONCE,
  });
  const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
  const contenderFresh = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_LOSER,
    ownerNonce: RECOV_FRESH_NONCE_B,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  // Distinct published-winner canonical record (not old, not contender).
  const publishedWinner = recoveryLockRecord({
    ownerPid: RECOV_OWNER_PID_FRESH,
    ownerNonce: RECOV_FRESH_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  const winnerBytes = lockRecordCanonicalBytes(publishedWinner);
  const winnerRef = lockRefFromRecord('transaction-lock', publishedWinner);

  requireRecoveryMethod(
    store,
    'acquireRecoveryLockForManualRepair',
    'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
  );
  counter.mutations.length = 0;

  const contenderPromise = store.acquireRecoveryLockForManualRepair({
    record: contenderFresh,
    claimId: RECOV_CLAIM_ID_B,
    expectedTransactionLockRef: txRef,
    manualInterventionLockRef: mirRef,
  });
  t.after(async () => {
    counter.releasePause();
    try {
      await contenderPromise;
    } catch {
      // settle pending acquisition so the test harness does not hang
    }
  });

  // Contender passed initial old-ref check and durably published+verified its claim.
  await claimHeld.wait();
  assert.equal(counter.claimVerifySeen, true, 'contender must hold durable claim before pause');
  const claimBytesAtHold = await readFile(join(metadataRoot, CLAIM_LEAF));
  const claimAtHold = JSON.parse(claimBytesAtHold.toString('utf8'));
  assert.equal(claimAtHold.kind, 'recovery-claim-lock');
  assert.equal(claimAtHold.claimId, RECOV_CLAIM_ID_B);
  assert.equal(claimAtHold.transactionId, RECOV_TX_ID);
  assert.equal(claimAtHold.ownerNonce, RECOV_FRESH_NONCE_B);
  assert.equal(
    counter.transactionMutationCount(),
    0,
    'before resume, contender must not have mutated transaction.lock',
  );

  // While paused: plant a different exact published-winner on the transaction leaf.
  await writeFile(join(metadataRoot, TX_LEAF), winnerBytes, { mode: 0o600 });
  assert.equal(
    Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), winnerBytes),
    0,
    'precondition: published-winner bytes planted under pause',
  );

  counter.releasePause();

  await assert.rejects(
    () => contenderPromise,
    (error) => isTransactionInProgressError(error),
    'production bug: post-claim transaction drift must return/reject as transaction-in-progress',
  );

  // Hard: published winner bytes/ref remain exact.
  const afterTx = await readFile(join(metadataRoot, TX_LEAF));
  assert.equal(
    Buffer.compare(afterTx, winnerBytes),
    0,
    'published winner bytes must remain exact after contender rejection',
  );
  assert.equal(
    recoverySha256Hex(afterTx),
    winnerRef.sha256,
    'published winner ref sha256 must remain exact',
  );

  // Hard: contender's exact claim definitely remains (no catch/finally cleanup may pass).
  const residualBytes = await readFile(join(metadataRoot, CLAIM_LEAF));
  assert.equal(
    Buffer.compare(residualBytes, claimBytesAtHold),
    0,
    'contender exact claim bytes must remain byte-identical (no post-failure claim cleanup)',
  );
  const residual = JSON.parse(residualBytes.toString('utf8'));
  assert.equal(residual.kind, 'recovery-claim-lock');
  assert.equal(residual.claimId, RECOV_CLAIM_ID_B);
  assert.equal(residual.ownerNonce, RECOV_FRESH_NONCE_B);
  assert.notEqual(
    residual.expectedTransactionLockRef?.sha256,
    winnerRef.sha256,
    'residual claim must not reinterpret published winner as its expected old ref',
  );

  // Hard: no contender transaction unlink / O_EXCL write-open occurs.
  assert.equal(
    counter.transactionMutationCount(),
    0,
    'contender must not unlink or O_EXCL write-open transaction.lock after post-claim drift',
  );
  const unlinksOfTx = counter.mutations.filter((m) => m.kind === 'unlink');
  const exclOpensOfTx = counter.mutations.filter((m) => m.kind === 'open-excl');
  assert.equal(unlinksOfTx.length, 0, 'contender must never unlink published winner');
  assert.equal(exclOpensOfTx.length, 0, 'contender must never O_EXCL write-open transaction.lock');
});

test('recovery claim and transaction lock observation fail closed on symlink directory mode noncanonical malformed and ref drift', async (t) => {
  const createStore = requireMetadataFactory('createLaunchAgentMetadataStore');
  const createForTest = requireMetadataFactory('createLaunchAgentMetadataStoreForTest');

  await t.test('transaction lock observation: symlink fails closed without following', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const store = createStore({ metadataRoot });
    await store.initialize();
    const victimDir = await mkdtemp(join(tmpdir(), 'linke-la-tx-victim-'));
    st.after(async () => {
      await rm(victimDir, { recursive: true, force: true });
    });
    const victim = join(victimDir, 'victim.lock');
    const victimBytes = Buffer.from('do-not-follow-tx-symlink');
    await writeFile(victim, victimBytes, { mode: 0o600 });
    await symlink(victim, join(metadataRoot, TX_LEAF));
    requireRecoveryMethod(
      store,
      'readTransactionLockObservation',
      'production bug: store.readTransactionLockObservation must exist for transaction lock observation',
    );
    await assert.rejects(
      () => store.readTransactionLockObservation(),
      (error) => isLifecycleError(error),
      'production bug: transaction.lock symlink must fail closed',
    );
    assert.equal(Buffer.compare(await readFile(victim), victimBytes), 0);
    assert.equal((await lstat(join(metadataRoot, TX_LEAF))).isSymbolicLink(), true);
  });

  await t.test('recovery claim observation: directory at leaf fails closed', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const store = createStore({ metadataRoot });
    await store.initialize();
    await mkdir(join(metadataRoot, CLAIM_LEAF), { mode: 0o700 });
    requireRecoveryMethod(
      store,
      'readRecoveryClaimObservation',
      'production bug: store.readRecoveryClaimObservation must exist for recovery claim observation',
    );
    await assert.rejects(
      () => store.readRecoveryClaimObservation(),
      (error) => isLifecycleError(error),
      'production bug: directory at recovery-claim.lock must fail closed',
    );
  });

  await t.test('transaction lock observation: mode drift 0644 fails closed without auto-repair', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const store = createStore({ metadataRoot });
    await store.initialize();
    const record = recoveryLockRecord();
    await store.acquireTransactionLock(record);
    await chmod(join(metadataRoot, TX_LEAF), 0o644);
    requireRecoveryMethod(
      store,
      'readTransactionLockObservation',
      'production bug: store.readTransactionLockObservation must exist for transaction lock observation',
    );
    await assert.rejects(
      () => store.readTransactionLockObservation(),
      (error) => isLifecycleError(error),
      'production bug: mode-drift transaction.lock must fail closed',
    );
    assert.equal((await lstat(join(metadataRoot, TX_LEAF))).mode & 0o777, 0o644);
  });

  await t.test('recovery claim observation: noncanonical key order fails closed', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const store = createStore({ metadataRoot });
    await store.initialize();
    const oldRecord = recoveryLockRecord();
    const mirRecord = recoveryLockRecord({
      ownerPid: RECOV_OWNER_PID_MIR,
      ownerNonce: RECOV_MIR_NONCE,
    });
    const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
    const freshRecord = recoveryLockRecord({
      ownerPid: RECOV_OWNER_PID_FRESH,
      ownerNonce: RECOV_FRESH_NONCE,
      bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
      processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
    });
    const claim = claimRecordExact({
      expectedTransactionLockRef: txRef,
      manualInterventionLockRef: mirRef,
      freshTransactionLockRef: lockRefFromRecord('transaction-lock', freshRecord),
    });
    const canonical = claimRecordCanonicalBytes(claim);
    const nonCanonical = Buffer.from(JSON.stringify({
      freshTransactionLockRef: claim.freshTransactionLockRef,
      manualInterventionLockRef: claim.manualInterventionLockRef,
      expectedTransactionLockRef: claim.expectedTransactionLockRef,
      processStartIdentity: claim.processStartIdentity,
      bootSessionIdentity: claim.bootSessionIdentity,
      ownerNonce: claim.ownerNonce,
      ownerPid: claim.ownerPid,
      transactionId: claim.transactionId,
      claimId: claim.claimId,
      kind: claim.kind,
      schemaVersion: claim.schemaVersion,
    }), 'utf8');
    assert.notEqual(Buffer.compare(nonCanonical, canonical), 0);
    await plantOwnedLeaf(metadataRoot, CLAIM_LEAF, nonCanonical);
    requireRecoveryMethod(
      store,
      'readRecoveryClaimObservation',
      'production bug: store.readRecoveryClaimObservation must exist for recovery claim observation',
    );
    await assert.rejects(
      () => store.readRecoveryClaimObservation(),
      (error) => isLifecycleError(error),
      'production bug: noncanonical claim bytes must fail closed',
    );
  });

  await t.test('recovery claim observation: malformed schema fails closed', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const store = createStore({ metadataRoot });
    await store.initialize();
    await plantOwnedLeaf(
      metadataRoot,
      CLAIM_LEAF,
      Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'not-a-claim' }), 'utf8'),
    );
    requireRecoveryMethod(
      store,
      'readRecoveryClaimObservation',
      'production bug: store.readRecoveryClaimObservation must exist for recovery claim observation',
    );
    await assert.rejects(
      () => store.readRecoveryClaimObservation(),
      (error) => isLifecycleError(error),
      'production bug: malformed claim schema must fail closed',
    );
  });

  await t.test('recovery lock primitive: claim symlink is not followed or overwritten (O_EXCL implies O_NOFOLLOW)', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const store = createForTest({
      metadataRoot,
      fs: fsPromises,
      onDurabilityEvent: () => {},
    });
    await store.initialize();
    const oldRecord = recoveryLockRecord();
    const mirRecord = recoveryLockRecord({
      ownerPid: RECOV_OWNER_PID_MIR,
      ownerNonce: RECOV_MIR_NONCE,
    });
    const { txRef, mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
    const victimDir = await mkdtemp(join(tmpdir(), 'linke-la-claim-victim-'));
    st.after(async () => {
      await rm(victimDir, { recursive: true, force: true });
    });
    const victim = join(victimDir, 'victim-claim');
    const victimBytes = Buffer.from('claim-symlink-victim-must-not-be-overwritten');
    await writeFile(victim, victimBytes, { mode: 0o600 });
    await symlink(victim, join(metadataRoot, CLAIM_LEAF));
    const freshRecord = recoveryLockRecord({
      ownerPid: RECOV_OWNER_PID_FRESH,
      ownerNonce: RECOV_FRESH_NONCE,
      bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
      processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
    });
    requireRecoveryMethod(
      store,
      'acquireRecoveryLockForManualRepair',
      'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
    );
    await assert.rejects(
      () => store.acquireRecoveryLockForManualRepair({
        record: freshRecord,
        claimId: RECOV_CLAIM_ID,
        expectedTransactionLockRef: txRef,
        manualInterventionLockRef: mirRef,
      }),
      (error) => isLifecycleError(error),
      'production bug: O_EXCL claim creation must not follow/overwrite symlink (O_NOFOLLOW contract)',
    );
    assert.equal(Buffer.compare(await readFile(victim), victimBytes), 0);
    assert.equal((await lstat(join(metadataRoot, CLAIM_LEAF))).isSymbolicLink(), true);
  });

  await t.test('recovery lock primitive: ref drift on expectedTransactionLockRef fails closed without mutation', async (st) => {
    const metadataRoot = await makeRecoveryTempRoot(st);
    const counter = createTransactionMutationCounter(metadataRoot);
    const store = createForTest({
      metadataRoot,
      fs: counter.fs,
      onDurabilityEvent: () => {},
    });
    await store.initialize();
    const oldRecord = recoveryLockRecord();
    const mirRecord = recoveryLockRecord({
      ownerPid: RECOV_OWNER_PID_MIR,
      ownerNonce: RECOV_MIR_NONCE,
    });
    const { mirRef } = await setupMirHeldTransaction(store, { oldRecord, mirRecord });
    const drifted = {
      kind: 'transaction-lock',
      transactionId: RECOV_TX_ID,
      ownerNonce: RECOV_OLD_NONCE,
      sha256: 'f'.repeat(64),
    };
    const beforeTx = await readFile(join(metadataRoot, TX_LEAF));
    const freshRecord = recoveryLockRecord({
      ownerPid: RECOV_OWNER_PID_FRESH,
      ownerNonce: RECOV_FRESH_NONCE,
      bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
      processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
    });
    counter.mutations.length = 0;
    requireRecoveryMethod(
      store,
      'acquireRecoveryLockForManualRepair',
      'production bug: store.acquireRecoveryLockForManualRepair must exist for recovery lock primitive',
    );
    await assert.rejects(
      () => store.acquireRecoveryLockForManualRepair({
        record: freshRecord,
        claimId: RECOV_CLAIM_ID,
        expectedTransactionLockRef: drifted,
        manualInterventionLockRef: mirRef,
      }),
      (error) => isLifecycleError(error),
      'production bug: expectedTransactionLockRef drift must fail closed',
    );
    assert.equal(counter.transactionMutationCount(), 0);
    assert.equal(Buffer.compare(await readFile(join(metadataRoot, TX_LEAF)), beforeTx), 0);
  });
});

// ---------------------------------------------------------------------------
// Task 6B.0 Task 3 RED：coordinator process identity on every new lock
// ---------------------------------------------------------------------------

const COORD_FAKE_BOOT = 'fake-boot-session-v1';
const COORD_FAKE_PROCESS_START = 'fake-process-start-v1';
const COORD_IDENTITY_CANARY = 'raw-process-identity-canary-MUST-NOT-LEAK';
const COORD_COMMIT_A = 'a'.repeat(40);
const COORD_COMMIT_B = 'b'.repeat(40);
const COORD_INSTALL_INPUT = Object.freeze({
  sourceCommit: COORD_COMMIT_A,
  scheduleSeconds: 300,
  controllerEnvironment: {},
});
const COORD_UPGRADE_INPUT = Object.freeze({
  sourceCommit: COORD_COMMIT_B,
  scheduleSeconds: 600,
  controllerEnvironment: { PORT: '1' },
});
const COORD_LOCK_RECORD_KEYS = Object.freeze([
  'schemaVersion', 'transactionId', 'ownerPid', 'ownerNonce',
  'bootSessionIdentity', 'processStartIdentity',
]);

function assertCoordinatorLifecycleInvalid(error) {
  assert.ok(error instanceof LaunchAgentLifecycleError);
  assert.equal(error.code, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
  assert.equal(error.message, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
  return true;
}

function assertAvailableIdentity(identity, value, label) {
  assertExactKeys(identity, ['available', 'value'], label);
  assert.equal(identity.available, true, `${label}.available`);
  assert.equal(identity.value, value, `${label}.value`);
  assertDeepFrozen(identity, label);
}

function assertCoordinatorLockAcquisition(entry, kind, label) {
  assertExactKeys(entry, ['kind', 'record'], label);
  assert.equal(entry.kind, kind, `${label}.kind`);
  assertExactKeys(entry.record, COORD_LOCK_RECORD_KEYS, `${label}.record`);
  assertAvailableIdentity(
    entry.record.bootSessionIdentity,
    COORD_FAKE_BOOT,
    `${label}.bootSessionIdentity`,
  );
  assertAvailableIdentity(
    entry.record.processStartIdentity,
    COORD_FAKE_PROCESS_START,
    `${label}.processStartIdentity`,
  );
  assertDeepFrozen(entry, label);
  // Detached：调用方突变不得污染 harness 历史。
  const bootBefore = entry.record.bootSessionIdentity.value;
  try {
    entry.record.bootSessionIdentity.value = 'mutated-boot';
  } catch {
    // frozen may throw
  }
  try {
    entry.kind = 'mutated';
  } catch {
    // frozen may throw
  }
  assert.equal(entry.record.bootSessionIdentity.value, bootBefore, `${label} detached value`);
  assert.equal(entry.kind, kind, `${label} detached kind`);
}

function coordinatorSurfaceText(value) {
  if (value instanceof Error) {
    const ownData = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        continue;
      }
      ownData[key] = descriptor.value;
    }
    return [
      String(value.name ?? ''),
      String(value.code ?? ''),
      String(value.message ?? ''),
      ...collectStrings(ownData),
    ].join('\n');
  }
  return JSON.stringify(collectStrings(value));
}

function assertNoCoordinatorCanary(value, label) {
  assert.equal(
    coordinatorSurfaceText(value).includes(COORD_IDENTITY_CANARY),
    false,
    `${label} must not leak raw canary`,
  );
}

function withProcessIdentityReader(baseDeps, reader) {
  return {
    ...baseDeps,
    processIdentityReader: reader,
  };
}

test('coordinator process identity: normal install records available identities once', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const receipt = validateLaunchAgentReceipt(await coordinator.install(COORD_INSTALL_INPUT));
  assert.equal(receipt.state, 'committed');

  const acquisitions = harness.lockAcquisitionsForTest();
  assert.equal(acquisitions.length, 1, 'exactly one successful transaction lock');
  assertCoordinatorLockAcquisition(acquisitions[0], 'transaction-lock', 'install.tx');
  assert.equal(harness.processIdentityCurrentCountForTest(), 1, 'current() once per new lock');

  // 二次读取 detached：突变不改历史。
  const again = harness.lockAcquisitionsForTest();
  assert.notEqual(again, acquisitions);
  try {
    again[0].record.ownerPid = 1;
  } catch {
    // frozen
  }
  assert.deepEqual(harness.lockAcquisitionsForTest()[0].record, acquisitions[0].record);
});

test('coordinator process identity: normal-flow MIR handoff records transaction and MIR identities', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  harness.seedInstalled({ sourceCommit: COORD_COMMIT_A });
  harness.resetObservations();
  harness.failNext('bootstrap-scheduler');
  harness.failAt('bootout-controller', 2);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const result = await coordinator.managedUpgrade(COORD_UPGRADE_INPUT);
  const projection = validateLaunchAgentReceipt(result);
  assert.equal(projection.state, 'manual-intervention-required');

  const acquisitions = harness.lockAcquisitionsForTest();
  assert.equal(acquisitions.length, 2, 'transaction + MIR successful acquisitions');
  assertCoordinatorLockAcquisition(acquisitions[0], 'transaction-lock', 'mir-handoff.tx');
  assertCoordinatorLockAcquisition(acquisitions[1], 'manual-intervention-lock', 'mir-handoff.mir');
  assert.equal(harness.processIdentityCurrentCountForTest(), 2, 'current() once per lock');
});

test('coordinator process identity: ordinary recovery lock records available identities once', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  harness.armCrashCapture({ kind: 'journal-state', state: 'committed', occurrence: 1 });
  const captureCoordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const completed = validateLaunchAgentReceipt(await captureCoordinator.install(COORD_INSTALL_INPUT));
  assert.equal(completed.state, 'committed');
  const image = harness.takeCrashImage();
  const revived = createLaunchAgentLifecycleHarness({ crashImage: image });
  assert.equal(revived.receiptFor(completed.transactionId), null);
  revived.resetObservations();
  revived.preProveRecoveryLockRelease({ transactionId: completed.transactionId });
  const receipt = validateLaunchAgentReceipt(
    await createLaunchAgentLifecycleCoordinator(revived.dependencies())
      .recover({ transactionId: completed.transactionId }),
  );
  assert.equal(receipt.state, 'committed');

  const acquisitions = revived.lockAcquisitionsForTest();
  assert.equal(acquisitions.length, 1, 'exactly one recovery transaction lock');
  assertCoordinatorLockAcquisition(acquisitions[0], 'transaction-lock', 'recovery.tx');
  assert.equal(revived.processIdentityCurrentCountForTest(), 1);
});

test('coordinator process identity: recovery-flow MIR handoff records transaction and MIR identities', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  harness.armCrashCapture({ kind: 'journal-state', state: 'prepared', occurrence: 1 });
  const captureCoordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const completed = validateLaunchAgentReceipt(await captureCoordinator.install(COORD_INSTALL_INPUT));
  const image = harness.takeCrashImage();
  const revived = createLaunchAgentLifecycleHarness({ crashImage: image });
  assert.equal(revived.journalStates(completed.transactionId).at(-1), 'prepared');
  revived.resetObservations();
  revived.preProveRecoveryLockRelease({ transactionId: completed.transactionId });
  await assert.rejects(
    () => createLaunchAgentLifecycleCoordinator(revived.dependencies())
      .recover({ transactionId: completed.transactionId }),
    (error) => {
      assert.ok(error instanceof LaunchAgentLifecycleError);
      assert.equal(error.code, LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
      return true;
    },
  );

  const acquisitions = revived.lockAcquisitionsForTest();
  assert.equal(acquisitions.length, 2, 'recovery tx + MIR acquisitions');
  assertCoordinatorLockAcquisition(acquisitions[0], 'transaction-lock', 'recovery-mir.tx');
  assertCoordinatorLockAcquisition(acquisitions[1], 'manual-intervention-lock', 'recovery-mir.mir');
  assert.equal(revived.processIdentityCurrentCountForTest(), 2);
});

test('coordinator process identity: current throw fails closed with zero lock and host mutation', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  const base = harness.dependencies();
  const coordinator = createLaunchAgentLifecycleCoordinator(withProcessIdentityReader(base, {
    async current() {
      throw new Error(COORD_IDENTITY_CANARY);
    },
    observe: base.processIdentityReader.observe,
  }));
  const hostBefore = harness.hostSnapshot();
  let thrown = null;
  await assert.rejects(
    () => coordinator.install(COORD_INSTALL_INPUT),
    (error) => {
      thrown = error;
      return assertCoordinatorLifecycleInvalid(error);
    },
  );
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.equal(harness.processIdentityCurrentCountForTest(), 0);
  assert.equal(harness.sentinels().hostMutationCount, 0);
  assert.equal(harness.sentinels().realLaunchctlCalls, 0);
  assert.deepEqual(harness.hostSnapshot(), hostBefore);
  assertNoCoordinatorCanary(thrown, 'thrown surface');
});

test('coordinator process identity: unavailable current fails closed with zero lock and host mutation', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  const base = harness.dependencies();
  const coordinator = createLaunchAgentLifecycleCoordinator(withProcessIdentityReader(base, {
    async current() {
      return {
        bootSessionIdentity: { available: false, value: null },
        processStartIdentity: { available: false, value: null },
      };
    },
    observe: base.processIdentityReader.observe,
  }));
  const hostBefore = harness.hostSnapshot();
  let thrown = null;
  await assert.rejects(
    () => coordinator.install(COORD_INSTALL_INPUT),
    (error) => {
      thrown = error;
      return assertCoordinatorLifecycleInvalid(error);
    },
  );
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.equal(harness.processIdentityCurrentCountForTest(), 0);
  assert.equal(harness.sentinels().hostMutationCount, 0);
  assert.equal(harness.sentinels().realLaunchctlCalls, 0);
  assert.deepEqual(harness.hostSnapshot(), hostBefore);
  assertNoCoordinatorCanary(thrown, 'thrown surface');
});

test('coordinator process identity: malformed current fails closed with zero lock and host mutation', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  const base = harness.dependencies();
  let getterReads = 0;
  const malformed = {};
  Object.defineProperty(malformed, 'bootSessionIdentity', {
    enumerable: true,
    get() {
      getterReads += 1;
      return { available: true, value: COORD_FAKE_BOOT };
    },
  });
  Object.defineProperty(malformed, 'processStartIdentity', {
    enumerable: true,
    value: { available: true, value: COORD_FAKE_PROCESS_START },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(malformed, 'extra', {
    enumerable: true,
    value: COORD_IDENTITY_CANARY,
    writable: true,
    configurable: true,
  });
  const coordinator = createLaunchAgentLifecycleCoordinator(withProcessIdentityReader(base, {
    async current() {
      return malformed;
    },
    observe: base.processIdentityReader.observe,
  }));
  const hostBefore = harness.hostSnapshot();
  let thrown = null;
  await assert.rejects(
    () => coordinator.install(COORD_INSTALL_INPUT),
    (error) => {
      thrown = error;
      return assertCoordinatorLifecycleInvalid(error);
    },
  );
  assert.equal(getterReads, 0, 'accessor-safe: hostile getter must not run');
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.equal(harness.processIdentityCurrentCountForTest(), 0);
  assert.equal(harness.sentinels().hostMutationCount, 0);
  assert.equal(harness.sentinels().realLaunchctlCalls, 0);
  assert.deepEqual(harness.hostSnapshot(), hostBefore);
  assertNoCoordinatorCanary(thrown, 'thrown surface');
});

// =============================================================================
// Task 6B.0 Task 4 RED — real Node-process recovery-lock proof
// Fail only because the bounded child helper/protocol is absent (not syntax).
// Do not register tests behind an existence check; do not create the helper here.
// Future helper path (exact): test/helpers/launchagent-lock-contender.js
// =============================================================================

/** Exact future child leaf; assertion text uses the leaf only (no absolute path leak). */
const LOCK_CONTENDER_HELPER_LEAF = 'launchagent-lock-contender.js';
const LOCK_CONTENDER_HELPER_PATH = fileURLToPath(
  new URL(`./helpers/${LOCK_CONTENDER_HELPER_LEAF}`, import.meta.url),
);

/** Fixed 10-second parent-side watchdog per spawned child. */
const REAL_PROCESS_CHILD_TIMEOUT_MS = 10_000;
const REAL_PROCESS_STDOUT_CAP = 64 * 1024;
const REAL_PROCESS_STDERR_CAP = 16 * 1024;

const REAL_PROCESS_RESULT_KEYS = Object.freeze([
  'status',
  'claimId',
  'transactionLockRef',
  'manualInterventionLockRef',
  'observationStatuses',
  'transactionMutationCount',
]);

const REAL_PROC_TX_ID = 'f1a2b3c4-d5e6-4789-8abc-111111111111';
const REAL_PROC_TX_NONCE = 'f1a2b3c4-d5e6-4789-8abc-222222222222';
const REAL_PROC_MIR_NONCE = 'f1a2b3c4-d5e6-4789-8abc-333333333333';
const REAL_PROC_OWNER_NONCE_A = 'f1a2b3c4-d5e6-4789-8abc-444444444444';
const REAL_PROC_OWNER_NONCE_B = 'f1a2b3c4-d5e6-4789-8abc-555555555555';
const REAL_PROC_REPLACEMENT_NONCE = 'f1a2b3c4-d5e6-4789-8abc-888888888888';

/** Canonical lowercase UUID v4 (version nibble 4, variant 8|9|a|b). */
const CANONICAL_UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Safe deliberate identity mismatches (no path separators / control chars). */
const SAFE_BOOT_MISMATCH_VALUE =
  'boot-session-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE_PROCESS_START_MISMATCH_VALUE =
  'process-start-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

assert.notEqual(REAL_PROC_TX_ID, REAL_PROC_TX_NONCE);
assert.notEqual(REAL_PROC_TX_ID, REAL_PROC_MIR_NONCE);
assert.notEqual(REAL_PROC_OWNER_NONCE_A, REAL_PROC_OWNER_NONCE_B);

/**
 * Child-emitted claimId must be a canonical v4 UUID distinct from fixture ids.
 * Generation belongs to the future child only — parent never supplies claimId argv.
 */
function assertChildEmittedClaimId(claimId, distinctFrom, label) {
  assert.equal(typeof claimId, 'string', `${label} must be string`);
  assert.match(claimId, CANONICAL_UUID_V4_RE, `${label} must be canonical v4 UUID`);
  for (const [name, value] of Object.entries(distinctFrom)) {
    assert.notEqual(claimId, value, `${label} must be distinct from ${name}`);
  }
}

function isMissingLockContenderError(error) {
  if (error === null || typeof error !== 'object') return false;
  const code = error.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
}

function forceTerminateLockContender(child) {
  if (!child) return;
  try {
    if (typeof child.connected === 'boolean' && child.connected && typeof child.disconnect === 'function') {
      child.disconnect();
    }
  } catch {
    // ignore disconnect races
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore kill races
  }
}

function isExactClaimHeldIpc(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const keys = Reflect.ownKeys(message).filter((k) => typeof k === 'string');
  return keys.length === 1 && keys[0] === 'event' && message.event === 'claim-held';
}

function encodeLockRefBase64(ref) {
  assert.equal(ref === null || typeof ref !== 'object', false, 'lock ref must be object');
  assertExactObjectKeys(ref, ['kind', 'transactionId', 'ownerNonce', 'sha256'], 'lock ref for base64');
  // Canonical JSON bytes of the closed ref only — no paths or raw process identities.
  const bytes = Buffer.from(JSON.stringify({
    kind: ref.kind,
    transactionId: ref.transactionId,
    ownerNonce: ref.ownerNonce,
    sha256: ref.sha256,
  }), 'utf8');
  return bytes.toString('base64');
}

function parseExactChildResultLine(stdoutText, label) {
  assert.equal(typeof stdoutText, 'string', `${label} stdout must be string`);
  assert.equal(
    stdoutText.endsWith('\n'),
    true,
    `${label} must end with a newline terminator`,
  );
  const lines = stdoutText.split('\n').filter((line) => line.length > 0);
  assert.equal(
    lines.length,
    1,
    `${label} must emit exactly one nonempty newline-terminated JSON result line`,
  );
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    assert.fail(`${label} result line must be exact JSON`);
  }
  assertExactObjectKeys(parsed, REAL_PROCESS_RESULT_KEYS, `${label} result`);
  assert.equal(typeof parsed.status, 'string', `${label}.status`);
  assert.ok(
    parsed.claimId === null || typeof parsed.claimId === 'string',
    `${label}.claimId nullable string`,
  );
  assert.ok(
    parsed.transactionLockRef === null || typeof parsed.transactionLockRef === 'object',
    `${label}.transactionLockRef`,
  );
  assert.ok(
    parsed.manualInterventionLockRef === null || typeof parsed.manualInterventionLockRef === 'object',
    `${label}.manualInterventionLockRef`,
  );
  assert.ok(Array.isArray(parsed.observationStatuses), `${label}.observationStatuses array`);
  assert.equal(
    typeof parsed.transactionMutationCount,
    'number',
    `${label}.transactionMutationCount`,
  );
  assert.equal(
    Number.isInteger(parsed.transactionMutationCount),
    true,
    `${label}.transactionMutationCount integer`,
  );
  assert.ok(parsed.transactionMutationCount >= 0, `${label}.transactionMutationCount >= 0`);
  return parsed;
}

/**
 * Spawn the future lock-contender child with explicit IPC + piped stdout/stderr.
 * Never skips when the helper is absent — fails quickly with a protocol assertion.
 *
 * Future argv contract (helper still absent for this RED):
 *   owner-crash  <metadataRoot> <transactionId> <txNonce> <mirNonce>
 *   contend      <metadataRoot> <transactionId> <ownerNonce> <expectedTxRefBase64> <mirRefBase64>
 *   claim-crash  <metadataRoot> <transactionId> <ownerNonce> <expectedTxRefBase64> <mirRefBase64>
 */
function spawnLockContender(t, argv) {
  assert.ok(Array.isArray(argv) && argv.length >= 1, 'contender argv required');
  const mode = argv[0];
  assert.ok(
    mode === 'owner-crash' || mode === 'contend' || mode === 'claim-crash',
    'contender mode must be owner-crash|contend|claim-crash',
  );

  /** @type {{ resolve: Function, reject: Function }[]} */
  const claimHeldWaiters = [];
  /** @type {{ resolve: Function, reject: Function }[]} */
  const resultWaiters = [];
  const state = {
    claimHeldCount: 0,
    stdout: '',
    stderr: '',
    result: null,
    failure: null,
    exited: false,
    exitCode: null,
    exitSignal: null,
    settled: false,
    timer: null,
  };

  const child = fork(LOCK_CONTENDER_HELPER_PATH, argv, {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  });

  const settleFailure = (message) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    forceTerminateLockContender(child);
    const error = new assert.AssertionError({ message });
    state.failure = error;
    for (const waiter of claimHeldWaiters.splice(0)) waiter.reject(error);
    for (const waiter of resultWaiters.splice(0)) waiter.reject(error);
  };

  const settleSuccess = (result) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.result = result;
    for (const waiter of resultWaiters.splice(0)) waiter.resolve(result);
  };

  state.timer = setTimeout(() => {
    settleFailure('real-process recovery lock: child watchdog timeout');
  }, REAL_PROCESS_CHILD_TIMEOUT_MS);

  t.after(() => {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    forceTerminateLockContender(child);
    try {
      if (child.stdout) child.stdout.destroy();
    } catch {
      // ignore
    }
    try {
      if (child.stderr) child.stderr.destroy();
    } catch {
      // ignore
    }
  });

  child.on('error', (error) => {
    if (isMissingLockContenderError(error)) {
      settleFailure(
        `real-process recovery lock: required bounded child protocol is missing (${LOCK_CONTENDER_HELPER_LEAF})`,
      );
      return;
    }
    settleFailure('real-process recovery lock: child process error');
  });

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (state.stdout.length < REAL_PROCESS_STDOUT_CAP) {
        state.stdout += chunk;
      }
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (state.stderr.length < REAL_PROCESS_STDERR_CAP) {
        state.stderr += chunk;
      }
    });
  }

  child.on('message', (message) => {
    if (!isExactClaimHeldIpc(message)) {
      settleFailure('real-process recovery lock: malformed or unexpected IPC message');
      return;
    }
    state.claimHeldCount += 1;
    if (state.claimHeldCount > 1) {
      settleFailure('real-process recovery lock: duplicate claim-held IPC');
      return;
    }
    for (const waiter of claimHeldWaiters.splice(0)) waiter.resolve(undefined);
  });

  child.on('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.settled) return;

    // Winner death after claim-held but before final JSON must not hang the parent.
    if (state.claimHeldCount === 1 && state.stdout.trim().length === 0) {
      settleFailure('real-process recovery lock: child exited before final result after claim-held');
      return;
    }

    // Empty final protocol with no claim-held: missing helper / protocol (fail fast, no hang).
    if (state.claimHeldCount === 0 && state.stdout.trim().length === 0) {
      settleFailure(
        `real-process recovery lock: required bounded child protocol is missing (${LOCK_CONTENDER_HELPER_LEAF})`,
      );
      return;
    }

    try {
      if (state.stderr.length > 0) {
        settleFailure('real-process recovery lock: child stderr must be empty on success path');
        return;
      }
      const result = parseExactChildResultLine(state.stdout, 'real-process recovery lock child');
      settleSuccess(result);
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        settleFailure(error.message);
        return;
      }
      settleFailure('real-process recovery lock: child result parse failure');
    }
  });

  return {
    child,
    get pid() {
      return child.pid;
    },
    get claimHeldCount() {
      return state.claimHeldCount;
    },
    get exitCode() {
      return state.exitCode;
    },
    get failure() {
      return state.failure;
    },
    resume() {
      assert.equal(
        state.claimHeldCount,
        1,
        'real-process recovery lock: resume requires exactly one claim-held',
      );
      assert.equal(
        child.connected,
        true,
        'real-process recovery lock: IPC must be connected for resume',
      );
      child.send({ command: 'resume' });
    },
    waitClaimHeld() {
      if (state.failure) return Promise.reject(state.failure);
      if (state.claimHeldCount >= 1) return Promise.resolve();
      if (state.exited) {
        return Promise.reject(new assert.AssertionError({
          message: 'real-process recovery lock: child exited without claim-held',
        }));
      }
      return new Promise((resolve, reject) => {
        claimHeldWaiters.push({ resolve, reject });
      });
    },
    waitFinalResult() {
      if (state.failure) return Promise.reject(state.failure);
      if (state.result) return Promise.resolve(state.result);
      return new Promise((resolve, reject) => {
        resultWaiters.push({ resolve, reject });
      });
    },
  };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    return true;
  }
}

async function makeRealProcessTempRoot(t) {
  const container = await mkdtemp(join(tmpdir(), 'linke-la-realproc-'));
  t.after(async () => {
    await rm(container, { recursive: true, force: true });
  });
  return join(container, 'metadata');
}

async function openProductionStore(metadataRoot) {
  const createStore = requireMetadataFactory('createLaunchAgentMetadataStore');
  const store = createStore({ metadataRoot });
  await store.initialize();
  return store;
}

function assertLockRefShape(ref, kind, label) {
  assertExactObjectKeys(ref, ['kind', 'transactionId', 'ownerNonce', 'sha256'], label);
  assert.equal(ref.kind, kind, `${label}.kind`);
  assert.equal(typeof ref.transactionId, 'string', `${label}.transactionId`);
  assert.equal(typeof ref.ownerNonce, 'string', `${label}.ownerNonce`);
  assert.match(ref.sha256, SHA256_HEX, `${label}.sha256`);
}

async function readExactLeafBytes(metadataRoot, leaf) {
  return readFile(join(metadataRoot, leaf));
}

async function assertClaimAbsent(metadataRoot) {
  await assert.rejects(
    () => access(join(metadataRoot, CLAIM_LEAF)),
    (error) => error && error.code === 'ENOENT',
    'recovery-claim.lock must be absent',
  );
}

/**
 * Owner-crash seed via future child protocol: writes real-identity tx+MIR then exits.
 * Returns closed production observations/refs after the child is proven dead.
 */
async function runOwnerCrashSeed(t, metadataRoot, {
  transactionId = REAL_PROC_TX_ID,
  txNonce = REAL_PROC_TX_NONCE,
  mirNonce = REAL_PROC_MIR_NONCE,
} = {}) {
  const owner = spawnLockContender(t, [
    'owner-crash',
    metadataRoot,
    transactionId,
    txNonce,
    mirNonce,
  ]);
  const ownerResult = await owner.waitFinalResult();
  assert.equal(ownerResult.status, 'owner-crashed', 'owner-crash exact status');
  assert.equal(ownerResult.claimId, null, 'owner-crash publishes no claim id');
  assert.equal(owner.claimHeldCount, 0, 'owner-crash must not emit claim-held');
  assert.equal(owner.exitCode, 0, 'owner-crash child must exit 0');
  assert.equal(isProcessAlive(owner.pid), false, 'owner PID must be dead after owner-crash');

  assertLockRefShape(ownerResult.transactionLockRef, 'transaction-lock', 'owner tx ref');
  assertLockRefShape(
    ownerResult.manualInterventionLockRef,
    'manual-intervention-lock',
    'owner mir ref',
  );
  assert.equal(ownerResult.transactionLockRef.transactionId, transactionId);
  assert.equal(ownerResult.transactionLockRef.ownerNonce, txNonce);
  assert.equal(ownerResult.manualInterventionLockRef.transactionId, transactionId);
  assert.equal(ownerResult.manualInterventionLockRef.ownerNonce, mirNonce);

  const store = await openProductionStore(metadataRoot);
  requireRecoveryMethod(store, 'readTransactionLockObservation');
  const txObs = await store.readTransactionLockObservation();
  assert.equal(txObs === null, false, 'owner-crash must leave transaction.lock');
  assert.equal(txObs.kind, 'transaction-lock-observation');
  assert.deepEqual(txObs.ref, ownerResult.transactionLockRef);

  const txBytes = await readExactLeafBytes(metadataRoot, TX_LEAF);
  const mirBytes = await readExactLeafBytes(metadataRoot, MIR_LEAF);
  assert.equal(recoverySha256Hex(txBytes), ownerResult.transactionLockRef.sha256);
  assert.equal(recoverySha256Hex(mirBytes), ownerResult.manualInterventionLockRef.sha256);
  await assertClaimAbsent(metadataRoot);

  return {
    ownerResult,
    ownerPid: owner.pid,
    txRef: ownerResult.transactionLockRef,
    mirRef: ownerResult.manualInterventionLockRef,
    txBytes,
    mirBytes,
    store,
  };
}

function spawnContendChild(t, {
  metadataRoot,
  transactionId,
  ownerNonce,
  expectedTxRef,
  mirRef,
}) {
  return spawnLockContender(t, [
    'contend',
    metadataRoot,
    transactionId,
    ownerNonce,
    encodeLockRefBase64(expectedTxRef),
    encodeLockRefBase64(mirRef),
  ]);
}

function spawnClaimCrashChild(t, {
  metadataRoot,
  transactionId,
  ownerNonce,
  expectedTxRef,
  mirRef,
}) {
  return spawnLockContender(t, [
    'claim-crash',
    metadataRoot,
    transactionId,
    ownerNonce,
    encodeLockRefBase64(expectedTxRef),
    encodeLockRefBase64(mirRef),
  ]);
}

async function seedMirHeldWithRecord(store, {
  transactionId,
  ownerPid,
  ownerNonce,
  mirNonce,
  bootSessionIdentity,
  processStartIdentity,
  mirBootSessionIdentity = bootSessionIdentity,
  mirProcessStartIdentity = processStartIdentity,
}) {
  const oldRecord = {
    schemaVersion: 1,
    transactionId,
    ownerPid,
    ownerNonce,
    bootSessionIdentity,
    processStartIdentity,
  };
  const mirRecord = {
    schemaVersion: 1,
    transactionId,
    ownerPid,
    ownerNonce: mirNonce,
    bootSessionIdentity: mirBootSessionIdentity,
    processStartIdentity: mirProcessStartIdentity,
  };
  const txRef = await store.acquireTransactionLock(oldRecord);
  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  const txBytes = lockRecordCanonicalBytes(oldRecord);
  const mirBytes = lockRecordCanonicalBytes(mirRecord);
  assert.equal(txRef.sha256, recoverySha256Hex(txBytes));
  assert.equal(mirRef.sha256, recoverySha256Hex(mirBytes));
  return { oldRecord, mirRecord, txRef, mirRef, txBytes, mirBytes };
}

// ---------------------------------------------------------------------------
// 1. Real owner crash + two-contender race
// ---------------------------------------------------------------------------

test('real-process recovery lock: owner-crash two-contender race single winner', async (t) => {
  const metadataRoot = await makeRealProcessTempRoot(t);
  const seed = await runOwnerCrashSeed(t, metadataRoot);

  const contenderA = spawnContendChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    expectedTxRef: seed.txRef,
    mirRef: seed.mirRef,
  });
  const contenderB = spawnContendChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_B,
    expectedTxRef: seed.txRef,
    mirRef: seed.mirRef,
  });

  // Do not preselect the winner: first exact claim-held identifies the observed winner.
  const winnerSide = await Promise.race([
    contenderA.waitClaimHeld().then(() => 'A'),
    contenderB.waitClaimHeld().then(() => 'B'),
  ]);
  const winner = winnerSide === 'A' ? contenderA : contenderB;
  const loser = winnerSide === 'A' ? contenderB : contenderA;
  const winnerNonce = winnerSide === 'A' ? REAL_PROC_OWNER_NONCE_A : REAL_PROC_OWNER_NONCE_B;

  assert.equal(winner.claimHeldCount, 1, 'exactly one claim-held on observed winner');
  assert.equal(loser.claimHeldCount, 0, 'loser must not emit claim-held before loser finish');

  // Require loser finish before resume — no premature resume.
  const loserResult = await loser.waitFinalResult();
  assert.equal(loserResult.status, 'transaction-in-progress');
  assert.equal(loserResult.claimId, null);
  assert.equal(loserResult.transactionMutationCount, 0);
  assert.equal(loser.claimHeldCount, 0, 'loser path must never emit claim-held');
  assert.equal(loser.exitCode, 0);
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), seed.txBytes),
    0,
    'loser must not mutate transaction.lock bytes',
  );
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, MIR_LEAF), seed.mirBytes),
    0,
    'loser must not mutate MIR bytes',
  );

  winner.resume();
  const winnerResult = await winner.waitFinalResult();
  assert.equal(winnerResult.status, 'acquired');
  assert.equal(winnerResult.claimId, null, 'normal winner success leaves no claim id');
  assert.equal(
    winnerResult.transactionMutationCount,
    2,
    'winner mutation count must be 2 (old unlink + fresh O_EXCL write-open)',
  );
  assert.equal(winner.claimHeldCount, 1, 'winner path: exactly one claim-held');
  assert.equal(winner.exitCode, 0);

  assertLockRefShape(winnerResult.transactionLockRef, 'transaction-lock', 'winner tx ref');
  assert.equal(winnerResult.transactionLockRef.transactionId, REAL_PROC_TX_ID);
  assert.equal(winnerResult.transactionLockRef.ownerNonce, winnerNonce);
  assert.deepEqual(winnerResult.manualInterventionLockRef, seed.mirRef);

  const store = await openProductionStore(metadataRoot);
  requireRecoveryMethod(store, 'readTransactionLockObservation');
  requireRecoveryMethod(store, 'readRecoveryClaimObservation');
  const txObs = await store.readTransactionLockObservation();
  assert.equal(txObs === null, false);
  assert.deepEqual(txObs.ref, winnerResult.transactionLockRef);
  assert.equal(txObs.record.ownerPid, winner.pid, 'published owner must be winner child PID');
  assert.equal(txObs.record.ownerNonce, winnerNonce);
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, MIR_LEAF), seed.mirBytes),
    0,
    'MIR bytes must remain unchanged after winner success',
  );
  assert.deepEqual(winnerResult.manualInterventionLockRef, seed.mirRef);
  const claimObs = await store.readRecoveryClaimObservation();
  assert.equal(claimObs, null, 'normal winner success must leave no recovery claim');
});

// ---------------------------------------------------------------------------
// 2. Identity / liveness fail-closed matrix
// ---------------------------------------------------------------------------

test('real-process recovery lock: identity fail-closed matrix in fresh roots', async (t) => {
  const reader = createLaunchAgentProcessIdentityReader();
  const parentIdentity = await reader.current();
  assert.equal(parentIdentity.bootSessionIdentity.available, true, 'parent boot identity available');
  assert.equal(
    parentIdentity.processStartIdentity.available,
    true,
    'parent process-start identity available',
  );

  const cases = [
    {
      name: 'unavailable boot',
      expectedStatus: 'unavailable',
      build(txId) {
        return {
          ownerPid: process.pid,
          bootSessionIdentity: { available: false, value: null },
          processStartIdentity: {
            available: true,
            value: parentIdentity.processStartIdentity.value,
          },
          transactionId: txId,
        };
      },
    },
    {
      name: 'unavailable process-start',
      expectedStatus: 'unavailable',
      build(txId) {
        return {
          ownerPid: process.pid,
          bootSessionIdentity: {
            available: true,
            value: parentIdentity.bootSessionIdentity.value,
          },
          processStartIdentity: { available: false, value: null },
          transactionId: txId,
        };
      },
    },
    {
      name: 'alive-same-owner',
      expectedStatus: 'alive-same-owner',
      build(txId) {
        return {
          ownerPid: process.pid,
          bootSessionIdentity: {
            available: true,
            value: parentIdentity.bootSessionIdentity.value,
          },
          processStartIdentity: {
            available: true,
            value: parentIdentity.processStartIdentity.value,
          },
          transactionId: txId,
        };
      },
    },
    {
      name: 'pid-reused',
      expectedStatus: 'pid-reused',
      build(txId) {
        return {
          ownerPid: process.pid,
          bootSessionIdentity: {
            available: true,
            value: parentIdentity.bootSessionIdentity.value,
          },
          processStartIdentity: {
            available: true,
            value: SAFE_PROCESS_START_MISMATCH_VALUE,
          },
          transactionId: txId,
        };
      },
    },
    {
      name: 'boot-session-mismatch',
      expectedStatus: 'boot-session-mismatch',
      build(txId) {
        return {
          ownerPid: process.pid,
          bootSessionIdentity: {
            available: true,
            value: SAFE_BOOT_MISMATCH_VALUE,
          },
          processStartIdentity: {
            available: true,
            value: parentIdentity.processStartIdentity.value,
          },
          transactionId: txId,
        };
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(`real-process recovery lock: identity ${fixture.name}`, async (st) => {
      const metadataRoot = await makeRealProcessTempRoot(st);
      const store = await openProductionStore(metadataRoot);
      const transactionId = randomUUID();
      const ownerNonce = randomUUID();
      const mirNonce = randomUUID();
      assert.notEqual(transactionId, ownerNonce);
      assert.notEqual(transactionId, mirNonce);

      const built = fixture.build(transactionId);
      const seeded = await seedMirHeldWithRecord(store, {
        transactionId,
        ownerPid: built.ownerPid,
        ownerNonce,
        mirNonce,
        bootSessionIdentity: built.bootSessionIdentity,
        processStartIdentity: built.processStartIdentity,
      });
      const beforeTx = await readExactLeafBytes(metadataRoot, TX_LEAF);
      const beforeMir = await readExactLeafBytes(metadataRoot, MIR_LEAF);

      const child = spawnContendChild(st, {
        metadataRoot,
        transactionId,
        ownerNonce: randomUUID(),
        expectedTxRef: seeded.txRef,
        mirRef: seeded.mirRef,
      });
      const result = await child.waitFinalResult();

      assert.equal(result.status, fixture.expectedStatus, `status for ${fixture.name}`);
      assert.equal(result.claimId, null, `${fixture.name} must publish no claimId`);
      assert.equal(result.transactionMutationCount, 0, `${fixture.name} zero mutations`);
      assert.equal(child.claimHeldCount, 0, `${fixture.name} must never emit claim-held`);
      assert.ok(
        Array.isArray(result.observationStatuses)
        && result.observationStatuses.length >= 1
        && result.observationStatuses.every((s) => s === fixture.expectedStatus),
        `${fixture.name} observationStatuses must be closed ${fixture.expectedStatus}`,
      );
      assert.equal(
        Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), beforeTx),
        0,
        `${fixture.name} must leave transaction.lock bytes unchanged`,
      );
      assert.equal(
        Buffer.compare(await readExactLeafBytes(metadataRoot, MIR_LEAF), beforeMir),
        0,
        `${fixture.name} must leave MIR bytes unchanged`,
      );
      assert.deepEqual(
        (await store.readTransactionLockObservation()).ref,
        seeded.txRef,
        `${fixture.name} must leave exact transaction ref`,
      );
      await assertClaimAbsent(metadataRoot);
      requireRecoveryMethod(store, 'readRecoveryClaimObservation');
      assert.equal(await store.readRecoveryClaimObservation(), null);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Claim-durable crash + later ordinary contender blocked
// ---------------------------------------------------------------------------

test('real-process recovery lock: claim-durable crash retains claim and blocks later contender', async (t) => {
  const metadataRoot = await makeRealProcessTempRoot(t);
  const seed = await runOwnerCrashSeed(t, metadataRoot);

  const crashChild = spawnClaimCrashChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    expectedTxRef: seed.txRef,
    mirRef: seed.mirRef,
  });
  const crashResult = await crashChild.waitFinalResult();
  assert.equal(crashResult.status, 'claim-durable-crash');
  assertChildEmittedClaimId(crashResult.claimId, {
    transactionId: REAL_PROC_TX_ID,
    txNonce: REAL_PROC_TX_NONCE,
    mirNonce: REAL_PROC_MIR_NONCE,
    ownerNonceA: REAL_PROC_OWNER_NONCE_A,
    ownerNonceB: REAL_PROC_OWNER_NONCE_B,
  }, 'claim-durable-crash claimId');
  assert.equal(crashResult.transactionMutationCount, 0);
  assert.equal(crashChild.claimHeldCount, 0, 'claim-crash exits before post-claim pause IPC');
  assert.equal(crashChild.exitCode, 0);
  assert.equal(isProcessAlive(crashChild.pid), false);

  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), seed.txBytes),
    0,
    'claim-crash must not mutate transaction.lock',
  );
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, MIR_LEAF), seed.mirBytes),
    0,
    'claim-crash must not mutate MIR',
  );

  const store = await openProductionStore(metadataRoot);
  requireRecoveryMethod(store, 'readRecoveryClaimObservation');
  requireRecoveryMethod(store, 'readTransactionLockObservation');
  const claimObs = await store.readRecoveryClaimObservation();
  assert.equal(claimObs === null, false, 'durable claim must remain');
  assert.equal(claimObs.kind, 'recovery-claim-observation');
  assert.equal(claimObs.record.claimId, crashResult.claimId);
  assert.equal(claimObs.record.ownerNonce, REAL_PROC_OWNER_NONCE_A);
  assert.equal(claimObs.record.transactionId, REAL_PROC_TX_ID);
  assert.deepEqual(claimObs.record.expectedTransactionLockRef, seed.txRef);
  assert.deepEqual(claimObs.record.manualInterventionLockRef, seed.mirRef);
  assert.equal(claimObs.record.ownerPid, crashChild.pid);

  const expectedClaim = claimRecordExact({
    claimId: crashResult.claimId,
    transactionId: claimObs.record.transactionId,
    ownerPid: claimObs.record.ownerPid,
    ownerNonce: claimObs.record.ownerNonce,
    bootSessionIdentity: claimObs.record.bootSessionIdentity,
    processStartIdentity: claimObs.record.processStartIdentity,
    expectedTransactionLockRef: seed.txRef,
    manualInterventionLockRef: seed.mirRef,
    freshTransactionLockRef: claimObs.record.freshTransactionLockRef,
  });
  assert.deepEqual(claimObs.record, expectedClaim);
  assert.deepEqual(claimObs.ref, claimRefFromRecord(expectedClaim));
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, CLAIM_LEAF), claimRecordCanonicalBytes(expectedClaim)),
    0,
  );

  const txObs = await store.readTransactionLockObservation();
  assert.deepEqual(txObs.ref, seed.txRef);

  const later = spawnContendChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_B,
    expectedTxRef: seed.txRef,
    mirRef: seed.mirRef,
  });
  const laterResult = await later.waitFinalResult();
  assert.equal(laterResult.status, 'transaction-in-progress');
  assert.equal(laterResult.claimId, null);
  assert.equal(laterResult.transactionMutationCount, 0);
  assert.equal(later.claimHeldCount, 0);

  const claimAfter = await store.readRecoveryClaimObservation();
  assert.deepEqual(claimAfter.record, expectedClaim);
  assert.deepEqual(claimAfter.ref, claimObs.ref);
  assert.equal(
    Buffer.compare(
      await readExactLeafBytes(metadataRoot, CLAIM_LEAF),
      claimRecordCanonicalBytes(expectedClaim),
    ),
    0,
    'later contender must leave original claim byte-for-byte',
  );
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), seed.txBytes),
    0,
    'later contender must not open/unlink transaction for mutation',
  );
  assert.deepEqual((await store.readTransactionLockObservation()).ref, seed.txRef);
});

// ---------------------------------------------------------------------------
// 4. Sequential stale-ref pre-claim rejection (Design A)
// ---------------------------------------------------------------------------

test('real-process recovery lock: sequential stale-ref pre-claim rejection', async (t) => {
  const metadataRoot = await makeRealProcessTempRoot(t);
  const seed = await runOwnerCrashSeed(t, metadataRoot);
  const oldTxRef = seed.txRef;
  const oldMirRef = seed.mirRef;

  const first = spawnContendChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    expectedTxRef: oldTxRef,
    mirRef: oldMirRef,
  });
  await first.waitClaimHeld();
  assert.equal(first.claimHeldCount, 1);
  first.resume();
  const firstResult = await first.waitFinalResult();
  assert.equal(firstResult.status, 'acquired');
  assert.equal(firstResult.transactionMutationCount, 2);
  assert.equal(firstResult.claimId, null);
  assert.equal(first.exitCode, 0);

  const store = await openProductionStore(metadataRoot);
  requireRecoveryMethod(store, 'readTransactionLockObservation');
  requireRecoveryMethod(store, 'readRecoveryClaimObservation');
  const winnerObs = await store.readTransactionLockObservation();
  assert.equal(winnerObs === null, false);
  assert.deepEqual(winnerObs.ref, firstResult.transactionLockRef);
  assert.equal(winnerObs.record.ownerPid, first.pid);
  assert.equal(winnerObs.record.ownerNonce, REAL_PROC_OWNER_NONCE_A);
  const winnerBytes = await readExactLeafBytes(metadataRoot, TX_LEAF);
  const mirBytes = await readExactLeafBytes(metadataRoot, MIR_LEAF);
  assert.equal(await store.readRecoveryClaimObservation(), null);

  // Second contender uses the original old ref — pre-claim ref mismatch.
  const second = spawnContendChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_B,
    expectedTxRef: oldTxRef,
    mirRef: oldMirRef,
  });
  const secondResult = await second.waitFinalResult();
  assert.equal(
    secondResult.status,
    LAUNCHAGENT_LIFECYCLE_CODES.INVALID,
    'stale expected ref must reject pre-claim as launchagent-lifecycle-invalid',
  );
  assert.equal(secondResult.claimId, null);
  assert.equal(secondResult.transactionMutationCount, 0);
  assert.equal(second.claimHeldCount, 0, 'pre-claim rejection must never emit claim-held');

  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), winnerBytes),
    0,
    'published winner bytes must be preserved',
  );
  assert.deepEqual(
    (await store.readTransactionLockObservation()).ref,
    firstResult.transactionLockRef,
    'published winner ref must be preserved',
  );
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, MIR_LEAF), mirBytes),
    0,
  );
  assert.equal(await store.readRecoveryClaimObservation(), null, 'claim observation must be null');
  await assertClaimAbsent(metadataRoot);
});

// ---------------------------------------------------------------------------
// 5. Post-claim drift residual claim (Design A)
// ---------------------------------------------------------------------------

test('real-process recovery lock: post-claim drift residual claim', async (t) => {
  const metadataRoot = await makeRealProcessTempRoot(t);
  const seed = await runOwnerCrashSeed(t, metadataRoot);

  const contender = spawnContendChild(t, {
    metadataRoot,
    transactionId: REAL_PROC_TX_ID,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    expectedTxRef: seed.txRef,
    mirRef: seed.mirRef,
  });
  await contender.waitClaimHeld();
  assert.equal(contender.claimHeldCount, 1);

  // Parent-controlled canonical replacement of transaction.lock (not production serialization).
  const replacementRecord = recoveryLockRecord({
    transactionId: REAL_PROC_TX_ID,
    ownerPid: 90909,
    ownerNonce: REAL_PROC_REPLACEMENT_NONCE,
    bootSessionIdentity: recoveryAvailableIdentity(BOOT_ID_LITERAL_B),
    processStartIdentity: recoveryAvailableIdentity(PROCESS_ID_LITERAL_B),
  });
  const replacementBytes = lockRecordCanonicalBytes(replacementRecord);
  const replacementRef = lockRefFromRecord('transaction-lock', replacementRecord);
  await writeFile(join(metadataRoot, TX_LEAF), replacementBytes, { mode: 0o600 });
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), replacementBytes),
    0,
    'precondition: replacement transaction.lock planted under pause',
  );
  assert.equal((await lstat(join(metadataRoot, TX_LEAF))).mode & 0o777, 0o600);

  contender.resume();
  const result = await contender.waitFinalResult();
  assert.equal(result.status, 'transaction-in-progress');
  assert.equal(result.transactionMutationCount, 0, 'zero child transaction mutations after drift');
  assertChildEmittedClaimId(result.claimId, {
    transactionId: REAL_PROC_TX_ID,
    txNonce: REAL_PROC_TX_NONCE,
    mirNonce: REAL_PROC_MIR_NONCE,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    replacementNonce: REAL_PROC_REPLACEMENT_NONCE,
  }, 'post-claim-drift claimId');
  assert.equal(contender.claimHeldCount, 1);

  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), replacementBytes),
    0,
    'replacement transaction bytes must remain unchanged',
  );
  assert.equal(
    recoverySha256Hex(await readExactLeafBytes(metadataRoot, TX_LEAF)),
    replacementRef.sha256,
  );
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, MIR_LEAF), seed.mirBytes),
    0,
    'MIR must remain unchanged',
  );

  const store = await openProductionStore(metadataRoot);
  requireRecoveryMethod(store, 'readRecoveryClaimObservation');
  requireRecoveryMethod(store, 'readTransactionLockObservation');
  const claimObs = await store.readRecoveryClaimObservation();
  assert.equal(claimObs === null, false, 'exactly one residual claim must remain');
  assert.equal(claimObs.record.claimId, result.claimId);
  assert.equal(claimObs.record.ownerPid, contender.pid);
  assert.equal(claimObs.record.ownerNonce, REAL_PROC_OWNER_NONCE_A);
  assert.equal(claimObs.record.transactionId, REAL_PROC_TX_ID);
  assert.deepEqual(claimObs.record.expectedTransactionLockRef, seed.txRef);
  assert.deepEqual(claimObs.record.manualInterventionLockRef, seed.mirRef);

  // Fresh ref is store-computed from the child's intended fresh record (PID + nonce + identities).
  const expectedFreshRecord = {
    schemaVersion: 1,
    transactionId: REAL_PROC_TX_ID,
    ownerPid: contender.pid,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    bootSessionIdentity: claimObs.record.bootSessionIdentity,
    processStartIdentity: claimObs.record.processStartIdentity,
  };
  const expectedFreshRef = lockRefFromRecord('transaction-lock', expectedFreshRecord);
  assert.deepEqual(claimObs.record.freshTransactionLockRef, expectedFreshRef);

  const expectedClaim = claimRecordExact({
    claimId: result.claimId,
    transactionId: REAL_PROC_TX_ID,
    ownerPid: contender.pid,
    ownerNonce: REAL_PROC_OWNER_NONCE_A,
    bootSessionIdentity: claimObs.record.bootSessionIdentity,
    processStartIdentity: claimObs.record.processStartIdentity,
    expectedTransactionLockRef: seed.txRef,
    manualInterventionLockRef: seed.mirRef,
    freshTransactionLockRef: expectedFreshRef,
  });
  assert.deepEqual(claimObs.record, expectedClaim);
  const expectedClaimBytes = claimRecordCanonicalBytes(expectedClaim);
  const expectedClaimRef = claimRefFromRecord(expectedClaim);
  assert.deepEqual(claimObs.ref, expectedClaimRef);
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, CLAIM_LEAF), expectedClaimBytes),
    0,
    'residual claim bytes must match independent test-side canonical bytes',
  );

  const txObs = await store.readTransactionLockObservation();
  assert.deepEqual(txObs.ref, replacementRef);
  assert.equal(
    Buffer.compare(await readExactLeafBytes(metadataRoot, TX_LEAF), replacementBytes),
    0,
  );
});
