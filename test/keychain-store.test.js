import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import {
  createSecurityRunner,
  KeychainStore,
  MAX_SECURITY_STDOUT_BYTES,
} from '../src/keychain-store.js';

/** Versioned envelope prefix used by production KeychainStore (single-line). */
const ENVELOPE_PREFIX = 'linke.kc.v1:';

/**
 * Mirror production envelope encoding for unit assertions only.
 * Tests never print the resulting hex/base64.
 * @param {string} secret
 */
function encodeEnvelope(secret) {
  return `${ENVELOPE_PREFIX}${Buffer.from(secret, 'utf8').toString('base64url')}`;
}

/**
 * @param {string} secret
 */
function envelopeHex(secret) {
  return Buffer.from(encodeEnvelope(secret), 'utf8').toString('hex');
}

/**
 * Fixed boolean secret compare for assertions (no actual/expected echo).
 * @param {string} actual
 * @param {string} expected
 * @param {string} code
 */
function assertSecretEqual(actual, expected, code = 'secret-mismatch') {
  const a = Buffer.from(String(actual), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  const ok = a.length === b.length && timingSafeEqual(a, b);
  assert.equal(ok, true, code);
}

/**
 * Assert text does not contain any of the sensitive fragments.
 * @param {string} text
 * @param {string[]} fragments
 * @param {string} code
 */
function assertNoLeak(text, fragments, code = 'leak') {
  for (const fragment of fragments) {
    if (!fragment) continue;
    assert.equal(text.includes(fragment), false, code);
  }
}

/**
 * Build a fake child_process-compatible spawn for createSecurityRunner tests.
 * Never invokes real Keychain or /usr/bin/security.
 */
function createFakeSpawn(scenario) {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options, stdinChunks: [] };
    calls.push(call);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    stderr.resume = () => {
      stderr.resumed = true;
    };
    const stdin = new EventEmitter();
    stdin.end = (chunk) => {
      if (chunk !== undefined) call.stdinChunks.push(chunk);
      queueMicrotask(() => {
        if (scenario.spawnError) {
          child.emit('error', scenario.spawnError);
          return;
        }
        if (scenario.stdinError) {
          stdin.emit('error', scenario.stdinError);
          return;
        }
        if (scenario.stdoutError) {
          stdout.emit('error', scenario.stdoutError);
          return;
        }
        if (scenario.stderrError) {
          stderr.emit('error', scenario.stderrError);
          return;
        }
        if (scenario.stdoutData !== undefined) {
          stdout.emit('data', Buffer.from(scenario.stdoutData));
        }
        if (scenario.stderrData !== undefined) {
          stderr.emit('data', Buffer.from(scenario.stderrData));
        }
        child.emit('close', scenario.closeCode === undefined ? 0 : scenario.closeCode);
      });
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    return child;
  };
  return { spawnImpl, calls };
}

/**
 * Stateful fake spawn that parses security -i stdin commands for KeychainStore unit paths.
 * Secrets stay in memory only; never logged.
 */
function createInteractiveKeychainFake(initial = new Map()) {
  /** @type {Map<string, string>} raw password bytes as utf8 strings (as security -w would return, without CLI NL) */
  const items = new Map(initial);
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options, stdinChunks: [] };
    calls.push(call);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    stderr.resume = () => {};
    const stdin = new EventEmitter();
    stdin.end = (chunk) => {
      if (chunk !== undefined) call.stdinChunks.push(chunk);
      const raw = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      call.stdinText = raw;
      queueMicrotask(() => {
        const line = raw.replace(/\n$/, '');
        const parts = line.split(' ').filter(Boolean);
        const op = parts[0] || '';
        const getFlag = (flag) => {
          const i = parts.indexOf(flag);
          return i >= 0 ? parts[i + 1] : undefined;
        };
        if (op === 'find-generic-password') {
          const service = getFlag('-s');
          const account = getFlag('-a');
          const key = `${service}\0${account}`;
          if (!items.has(key)) {
            child.emit('close', 44);
            return;
          }
          // security -w appends one trailing newline
          stdout.emit('data', Buffer.from(`${items.get(key)}\n`, 'utf8'));
          child.emit('close', 0);
          return;
        }
        if (op === 'add-generic-password') {
          const service = getFlag('-s');
          const account = getFlag('-a');
          const hex = getFlag('-X');
          const key = `${service}\0${account}`;
          if (call.forceAddExit !== undefined) {
            child.emit('close', call.forceAddExit);
            return;
          }
          if (hex) {
            items.set(key, Buffer.from(hex, 'hex').toString('utf8'));
          }
          child.emit('close', call.addExitCode === undefined ? 0 : call.addExitCode);
          return;
        }
        if (op === 'delete-generic-password') {
          const service = getFlag('-s');
          const account = getFlag('-a');
          const key = `${service}\0${account}`;
          if (!items.has(key)) {
            child.emit('close', 44);
            return;
          }
          items.delete(key);
          child.emit('close', 0);
          return;
        }
        child.emit('close', 1);
      });
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    return child;
  };
  return { spawnImpl, calls, items };
}

describe('createSecurityRunner', () => {
  it('locks binary to /usr/bin/security with args only -i and no TTY', async () => {
    const { spawnImpl, calls } = createFakeSpawn({ closeCode: 0, stdoutData: '' });
    const runner = createSecurityRunner({ spawnImpl });
    await runner(['-i'], { input: 'help\n' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].binary, '/usr/bin/security');
    assert.deepStrictEqual(calls[0].args, ['-i']);
    assert.deepStrictEqual(calls[0].options, { stdio: ['pipe', 'pipe', 'pipe'] });
    assert.ok(!Object.prototype.hasOwnProperty.call(calls[0].options, 'env'));
  });

  it('sends interactive command only via stdin; secret/hex/envelope never in argv or env', async () => {
    const secret = 'runner-stdin-secret';
    const hex = envelopeHex(secret);
    const envelope = encodeEnvelope(secret);
    const cmd = `add-generic-password -U -s com.linke.test -a device-token.alpha -X ${hex}\n`;
    const { spawnImpl, calls } = createFakeSpawn({ closeCode: 0, stdoutData: '' });
    const runner = createSecurityRunner({ spawnImpl });
    const result = await runner(['-i'], { input: cmd });
    assert.strictEqual(calls[0].binary, '/usr/bin/security');
    assert.deepStrictEqual(calls[0].args, ['-i']);
    assert.ok(!calls[0].args.includes(secret));
    assert.ok(!calls[0].args.includes(hex));
    assert.ok(!calls[0].args.includes(envelope));
    assert.ok(!calls[0].args.join('\0').includes(secret));
    const env = calls[0].options.env;
    if (env) {
      assertNoLeak(JSON.stringify(env), [secret, hex, envelope], 'env-leak');
    }
    const stdin = calls[0].stdinChunks[0];
    const stdinText = Buffer.isBuffer(stdin) ? stdin.toString('utf8') : String(stdin);
    assert.ok(stdinText.startsWith('add-generic-password -U -s com.linke.test -a device-token.alpha -X '));
    assert.ok(stdinText.endsWith('\n'));
    assert.ok(stdinText.includes(hex));
    assert.strictEqual(result.exitCode, 0);
  });

  it('collects stdout and never surfaces stderr content in result or errors', async () => {
    const { spawnImpl, calls } = createFakeSpawn({
      closeCode: 0,
      stdoutData: 'stored-from-stdout',
      stderrData: 'stderr-must-not-leak',
    });
    const runner = createSecurityRunner({ spawnImpl });
    const result = await runner(['-i'], {
      input: 'find-generic-password -s com.linke.test -a item -w\n',
    });
    assert.strictEqual(calls[0].binary, '/usr/bin/security');
    assert.deepStrictEqual(calls[0].args, ['-i']);
    assert.strictEqual(result.stdout, 'stored-from-stdout');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'stderr'));
    assert.ok(!JSON.stringify(result).includes('stderr-must-not-leak'));
  });

  it('maps child spawn error to LinkeError keychain-unavailable with exact message', async () => {
    const systemError = new Error('spawn EACCES /usr/bin/security');
    systemError.code = 'EACCES';
    const { spawnImpl } = createFakeSpawn({ spawnError: systemError });
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: 'help\n' }),
      (error) => (
        error.name === 'LinkeError'
        && error.code === 'keychain-unavailable'
        && error.message === 'keychain-unavailable'
        && !String(error.message).includes('EACCES')
        && !String(error.stack || '').includes('spawn EACCES')
      ),
    );
  });

  it('maps synchronous spawnImpl throw to keychain-unavailable without leaking system text or secrets', async () => {
    const probeSecret = 'sync-spawn-probe-secret';
    const spawnImpl = () => {
      const err = new Error(`spawn EACCES containing ${probeSecret}`);
      err.code = 'EACCES';
      throw err;
    };
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: `add-generic-password -U -s com.linke.test -a item -X deadbeef\n` }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.name === 'LinkeError'
          && error.code === 'keychain-unavailable'
          && error.message === 'keychain-unavailable'
          && !text.includes('EACCES')
          && !text.includes(probeSecret)
          && !text.includes('spawn EACCES');
      },
    );
  });

  it('maps close(null) to exitCode 1', async () => {
    const { spawnImpl } = createFakeSpawn({ closeCode: null, stdoutData: '' });
    const runner = createSecurityRunner({ spawnImpl });
    const result = await runner(['-i'], {
      input: 'find-generic-password -s com.linke.test -a item -w\n',
    });
    assert.strictEqual(result.exitCode, 1);
  });

  it('rejects stdin error including EPIPE as keychain-unavailable without leaking system text', async () => {
    const epiped = new Error('write EPIPE');
    epiped.code = 'EPIPE';
    const { spawnImpl } = createFakeSpawn({ stdinError: epiped });
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: 'add-generic-password -U -s com.linke.test -a item -X ab\n' }),
      (error) => (
        error.name === 'LinkeError'
        && error.code === 'keychain-unavailable'
        && error.message === 'keychain-unavailable'
        && !error.message.includes('EPIPE')
        && !String(error).includes('write EPIPE')
      ),
    );
  });

  it('maps synchronous stdin.end throw to keychain-unavailable without leaking system text or secrets', async () => {
    const probeSecret = 'stdin-end-sync-probe-secret';
    const spawnImpl = () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      const stdin = new EventEmitter();
      stdin.end = () => {
        const err = new Error(`write EPIPE containing ${probeSecret}`);
        err.code = 'EPIPE';
        throw err;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = stdin;
      return child;
    };
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: `probe ${probeSecret}\n` }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.name === 'LinkeError'
          && error.code === 'keychain-unavailable'
          && error.message === 'keychain-unavailable'
          && !text.includes('EPIPE')
          && !text.includes(probeSecret)
          && !text.includes('write EPIPE');
      },
    );
  });

  it('prefers same-turn stdin error after close as keychain-unavailable', async () => {
    const probeSecret = 'close-then-error-probe-secret';
    const spawnImpl = () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      const stdin = new EventEmitter();
      stdin.end = () => {
        child.emit('close', 0);
        const err = new Error(`write EPIPE containing ${probeSecret}`);
        err.code = 'EPIPE';
        stdin.emit('error', err);
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = stdin;
      return child;
    };
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: `probe ${probeSecret}\n` }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.name === 'LinkeError'
          && error.code === 'keychain-unavailable'
          && error.message === 'keychain-unavailable'
          && !text.includes('EPIPE')
          && !text.includes(probeSecret);
      },
    );
  });

  it('handles repeated stream errors without uncaught and settles unavailable once', async () => {
    const probeSecret = 'double-error-probe-secret';
    const stray = [];
    const onUncaught = (err) => { stray.push(err); };
    const onUnhandled = (reason) => { stray.push(reason); };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    try {
      const spawnImpl = () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        stderr.resume = () => {};
        const stdin = new EventEmitter();
        stdin.end = () => {
          queueMicrotask(() => {
            const first = new Error(`write EPIPE first containing ${probeSecret}`);
            first.code = 'EPIPE';
            const second = new Error(`write EPIPE second containing ${probeSecret}`);
            second.code = 'EPIPE';
            stdin.emit('error', first);
            stdin.emit('error', second);
          });
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = stdin;
        return child;
      };
      const runner = createSecurityRunner({ spawnImpl });
      await assert.rejects(
        runner(['-i'], { input: `probe ${probeSecret}\n` }),
        (error) => {
          const text = `${error}\n${error.message}\n${error.stack || ''}`;
          return error.name === 'LinkeError'
            && error.code === 'keychain-unavailable'
            && error.message === 'keychain-unavailable'
            && !text.includes('EPIPE')
            && !text.includes(probeSecret);
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(stray.length, 0, 'repeated stream errors must not uncaught/unhandled');
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('maps stdout stream error to keychain-unavailable without leaking system text or secrets', async () => {
    const probeSecret = 'stdout-stream-probe-secret';
    const streamError = new Error(`read EIO containing ${probeSecret}`);
    streamError.code = 'EIO';
    const { spawnImpl } = createFakeSpawn({ stdoutError: streamError });
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: 'find-generic-password -s com.linke.test -a item -w\n' }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.name === 'LinkeError'
          && error.code === 'keychain-unavailable'
          && error.message === 'keychain-unavailable'
          && !text.includes('EIO')
          && !text.includes(probeSecret)
          && !text.includes('read EIO');
      },
    );
  });

  it('maps stderr stream error to keychain-unavailable without leaking system text or secrets', async () => {
    const probeSecret = 'stderr-stream-probe-secret';
    const streamError = new Error(`read ECONNRESET containing ${probeSecret}`);
    streamError.code = 'ECONNRESET';
    const { spawnImpl } = createFakeSpawn({ stderrError: streamError });
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: 'find-generic-password -s com.linke.test -a item -w\n' }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.name === 'LinkeError'
          && error.code === 'keychain-unavailable'
          && error.message === 'keychain-unavailable'
          && !text.includes('ECONNRESET')
          && !text.includes(probeSecret)
          && !text.includes('read ECONNRESET');
      },
    );
  });

  it('writes interactive stdin payload without placing secrets in argv', async () => {
    const secret = 'stdin-only-secret-value';
    const hex = envelopeHex(secret);
    let written;
    const spawnImpl = (binary, args, options) => {
      assert.strictEqual(binary, '/usr/bin/security');
      assert.deepStrictEqual(args, ['-i']);
      assert.deepStrictEqual(options, { stdio: ['pipe', 'pipe', 'pipe'] });
      assert.ok(!args.includes(secret));
      assert.ok(!args.includes(hex));
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      const stdin = new EventEmitter();
      stdin.end = (chunk) => {
        written = chunk;
        queueMicrotask(() => child.emit('close', 0));
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = stdin;
      return child;
    };
    const runner = createSecurityRunner({ spawnImpl });
    const cmd = `add-generic-password -U -s com.linke.test -a device-token.alpha -X ${hex}\n`;
    await runner(['-i'], { input: cmd });
    const text = Buffer.isBuffer(written) ? written.toString('utf8') : String(written);
    // Fixed boolean + fixed message only — never strictEqual full stdin/cmd/hex on failure.
    assertSecretEqual(text, cmd, 'stdin-payload-mismatch');
  });

  it('fail-closes on oversized stdout without leaking chunk content or system text', async () => {
    const probeSecret = 'oversized-stdout-probe-secret';
    let killCount = 0;
    let destroyCount = 0;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.kill = () => {
        killCount += 1;
      };
      const stdout = new EventEmitter();
      stdout.destroy = () => {
        destroyCount += 1;
      };
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      stderr.destroy = () => {
        destroyCount += 1;
      };
      const stdin = new EventEmitter();
      stdin.destroy = () => {
        destroyCount += 1;
      };
      stdin.end = () => {
        queueMicrotask(() => {
          // Exactly at limit is allowed; one more byte must fail closed.
          stdout.emit('data', Buffer.alloc(MAX_SECURITY_STDOUT_BYTES, 0x41));
          stdout.emit('data', Buffer.from(`+${probeSecret}`, 'utf8'));
          // kill may race with close / stream errors — settle only once.
          child.emit('close', 0);
          stdout.emit('error', new Error(`post-kill read containing ${probeSecret}`));
        });
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = stdin;
      return child;
    };
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(['-i'], { input: 'find-generic-password -s com.linke.test -a item -w\n' }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.name === 'LinkeError'
          && error.code === 'keychain-unavailable'
          && error.message === 'keychain-unavailable'
          && !text.includes(probeSecret)
          && !text.includes('post-kill')
          && !text.includes('0x41');
      },
    );
    assert.equal(killCount >= 1, true, 'oversized-must-kill');
    assert.equal(destroyCount >= 1, true, 'oversized-must-destroy');
  });

  it('assertion failure diagnostics use fixed codes without probe secret or hex', () => {
    const probeSecret = 'assert-diag-probe-secret';
    const hex = envelopeHex(probeSecret);
    const envelope = encodeEnvelope(probeSecret);
    let caught;
    try {
      assertSecretEqual('not-the-secret', probeSecret, 'fixed-diag-code');
    } catch (error) {
      caught = error;
    }
    assert.equal(caught !== undefined, true, 'assert-must-throw');
    const text = `${caught}\n${caught.message}\n${caught.stack || ''}`;
    assert.equal(text.includes(probeSecret), false, 'diag-secret-leak');
    assert.equal(text.includes(hex), false, 'diag-hex-leak');
    assert.equal(text.includes(envelope), false, 'diag-envelope-leak');
    assert.equal(String(caught.message).includes('fixed-diag-code'), true, 'diag-fixed-code');
  });
});

describe('KeychainStore production security -i contract', () => {
  it('uses /usr/bin/security args only [-i]; no python helper; set stdin is add-generic-password -U -X', async () => {
    const secret = 'contract-secret-value';
    const hex = envelopeHex(secret);
    const { spawnImpl, calls } = createInteractiveKeychainFake();
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    await store.set('device-token.alpha', secret);
    assert.ok(calls.length >= 1, 'set must spawn at least once');
    for (const call of calls) {
      assert.strictEqual(call.binary, '/usr/bin/security');
      assert.deepStrictEqual(call.args, ['-i']);
      assert.ok(!call.args.includes(secret));
      assert.ok(!call.args.includes(hex));
      assert.ok(!call.args.some((a) => String(a).includes('python')));
      assert.ok(!call.args.some((a) => String(a).includes('keychain-generic-password')));
      if (call.options?.env) {
        assertNoLeak(JSON.stringify(call.options.env), [secret, hex], 'env-leak');
      }
    }
    const setCall = calls.find((c) => String(c.stdinText || '').includes('add-generic-password'));
    assert.ok(setCall, 'set must issue add-generic-password via stdin');
    const stdin = String(setCall.stdinText);
    assert.ok(stdin.startsWith('add-generic-password -U -s com.linke.test -a device-token.alpha -X '));
    assert.ok(stdin.includes(hex));
    assert.ok(stdin.endsWith('\n'));
    assert.equal(stdin.includes('delete-generic-password'), false, 'set must not delete');
    assert.equal(stdin.includes('find-generic-password') && stdin.includes('add-generic-password'), false);
  });

  it('set path never issues delete-generic-password (atomic -U only)', async () => {
    const secret = 'no-delete-on-set';
    const { spawnImpl, calls } = createInteractiveKeychainFake();
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    await store.set('item.alpha', secret);
    await store.set('item.alpha', `${secret}-updated`);
    for (const call of calls) {
      const text = String(call.stdinText || '');
      assert.equal(text.includes('delete-generic-password'), false, 'set-path-delete-forbidden');
      assert.ok(!call.args.includes('delete-generic-password'));
    }
    const adds = calls.filter((c) => String(c.stdinText || '').startsWith('add-generic-password'));
    assert.ok(adds.length >= 2);
    for (const add of adds) {
      assert.ok(String(add.stdinText).includes(' -U '));
      assert.ok(String(add.stdinText).includes(' -X '));
    }
  });

  it('fail-closed when interactive set returns non-zero; old value retained; no delete', async () => {
    const oldSecret = 'old-retained-secret';
    const newSecret = 'new-should-not-apply';
    const key = 'com.linke.test\0item.keep';
    const { spawnImpl, calls, items } = createInteractiveKeychainFake(
      new Map([[key, encodeEnvelope(oldSecret)]]),
    );
    // First call (add) fails; subsequent gets still see old
    let addCount = 0;
    const wrapped = (binary, args, options) => {
      const child = spawnImpl(binary, args, options);
      const origEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = (chunk) => {
        const text = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (text.startsWith('add-generic-password')) {
          addCount += 1;
          // Force failure without mutating items
          queueMicrotask(() => child.emit('close', 1));
          calls[calls.length - 1].stdinText = text;
          calls[calls.length - 1].stdinChunks.push(chunk);
          return;
        }
        return origEnd(chunk);
      };
      return child;
    };
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl: wrapped }),
      service: 'com.linke.test',
    });
    await assert.rejects(
      store.set('item.keep', newSecret),
      (error) => error.code === 'keychain-unavailable' && error.message === 'keychain-unavailable',
    );
    assert.equal(addCount, 1);
    assertSecretEqual(items.get(key), encodeEnvelope(oldSecret), 'old-envelope-retained');
    assertSecretEqual(await store.get('item.keep'), oldSecret, 'old-must-remain');
    assert.ok(calls.every((c) => !String(c.stdinText || '').includes('delete-generic-password')));
  });

  it('fail-closed when interactive exits 0 but value not updated; old retained; no delete', async () => {
    const oldSecret = 'still-old-secret';
    const newSecret = 'attempted-new-secret';
    const key = 'com.linke.test\0item.stale';
    const { spawnImpl, calls, items } = createInteractiveKeychainFake(
      new Map([[key, encodeEnvelope(oldSecret)]]),
    );
    const wrapped = (binary, args, options) => {
      const child = spawnImpl(binary, args, options);
      const origEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = (chunk) => {
        const text = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (text.startsWith('add-generic-password')) {
          // Exit 0 but do not update stored value
          calls[calls.length - 1].stdinText = text;
          calls[calls.length - 1].stdinChunks.push(chunk);
          queueMicrotask(() => child.emit('close', 0));
          return;
        }
        return origEnd(chunk);
      };
      return child;
    };
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl: wrapped }),
      service: 'com.linke.test',
    });
    await assert.rejects(
      store.set('item.stale', newSecret),
      (error) => error.code === 'keychain-unavailable' && error.message === 'keychain-unavailable',
    );
    assertSecretEqual(items.get(key), encodeEnvelope(oldSecret), 'stale-envelope-retained');
    assertSecretEqual(await store.get('item.stale'), oldSecret, 'stale-old-retained');
    assert.ok(calls.every((c) => !String(c.stdinText || '').includes('delete-generic-password')));
  });

  it('round-trips multi-line and NUL secrets through envelope encode/decode', async () => {
    const multi = '-----BEGIN\nLINE-TWO\nEND-----';
    const withNul = `pre${String.fromCharCode(0)}post\ntrail`;
    const { spawnImpl } = createInteractiveKeychainFake();
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    await store.set('tls.key.item', multi);
    assertSecretEqual(await store.get('tls.key.item'), multi, 'multi-mismatch');
    await store.set('tls.key.item', withNul);
    assertSecretEqual(await store.get('tls.key.item'), withNul, 'nul-mismatch');
  });

  it('get strips only one CLI trailing newline; preserves significant trailing newline in envelope payload', async () => {
    const secret = 'value-with-trailing-nl\n';
    const { spawnImpl } = createInteractiveKeychainFake();
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    await store.set('item.nl', secret);
    assertSecretEqual(await store.get('item.nl'), secret, 'trailing-nl-mismatch');
  });

  it('get is backward compatible with legacy plaintext items', async () => {
    const legacy = 'legacy-plaintext-token';
    const key = 'com.linke.test\0item.legacy';
    const { spawnImpl } = createInteractiveKeychainFake(new Map([[key, legacy]]));
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    assertSecretEqual(await store.get('item.legacy'), legacy, 'legacy-mismatch');
  });

  it('get treats prefix+invalid payload as legacy plaintext without leaking in errors', async () => {
    const weird = `${ENVELOPE_PREFIX}!!!not-valid-base64url!!!`;
    const key = 'com.linke.test\0item.weird';
    const { spawnImpl } = createInteractiveKeychainFake(new Map([[key, weird]]));
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    const got = await store.get('item.weird');
    assertSecretEqual(got, weird, 'compat-mismatch');
  });

  it('get maps empty keychain item to keychain-unavailable (empty secret never valid)', async () => {
    const key = 'com.linke.test\0item.empty';
    const { spawnImpl } = createInteractiveKeychainFake(new Map([[key, '']]));
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    await assert.rejects(
      store.get('item.empty'),
      (error) => error.code === 'keychain-unavailable' && error.message === 'keychain-unavailable',
    );
  });

  it('set rejects empty secret synchronously before spawn', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { stdout: '', exitCode: 0 };
    };
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    assert.throws(() => store.set('item.x', ''), (err) => err instanceof Error);
    assert.throws(() => store.set('item.x', null), (err) => err instanceof Error);
    assert.strictEqual(calls, 0);
  });

  it('stdout/stderr/error paths never leak secret, hex, or envelope material', async () => {
    const secret = 'leak-probe-secret-value';
    const hex = envelopeHex(secret);
    const envelope = encodeEnvelope(secret);
    const fragments = [secret, hex, envelope];
    const { spawnImpl, calls } = createInteractiveKeychainFake();
    const store = new KeychainStore({
      runner: createSecurityRunner({ spawnImpl }),
      service: 'com.linke.test',
    });
    await store.set('item.leak', secret);
    const got = await store.get('item.leak');
    assertSecretEqual(got, secret, 'leak-roundtrip');
    for (const call of calls) {
      assertNoLeak(JSON.stringify(call.args), fragments, 'args-leak');
      if (call.options) assertNoLeak(JSON.stringify(call.options), fragments, 'options-leak');
    }
  });
});

describe('KeychainStore', () => {
  it('writes through interactive stdin and never places the secret in argv', async () => {
    const calls = [];
    const secret = 'test-secret-value';
    const hex = envelopeHex(secret);
    const runner = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      if (String(options.input || '').startsWith('add-generic-password')) {
        return { stdout: '', exitCode: 0 };
      }
      // verify get after set
      return { stdout: `${encodeEnvelope(secret)}\n`, exitCode: 0 };
    };
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    await store.set('device-token.alpha', secret);
    assert.deepStrictEqual(calls[0].args, ['-i']);
    assert.ok(String(calls[0].input).startsWith('add-generic-password -U -s com.linke.test -a device-token.alpha -X '));
    assert.ok(String(calls[0].input).includes(hex));
    assert.ok(!calls[0].args.join(' ').includes(secret));
    assert.ok(!calls[0].args.join(' ').includes(hex));
  });

  it('returns decoded envelope from a successful lookup without double-stripping', async () => {
    const secret = 'stored-value\n';
    const runner = async () => ({ stdout: `${encodeEnvelope(secret)}\n`, exitCode: 0 });
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    assertSecretEqual(await store.get('device-token.alpha'), secret, 'decode-mismatch');
  });

  it('maps missing and permission failures to sanitized registered errors', async () => {
    const missing = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 44 }),
      service: 'com.linke.test',
    });
    await assert.rejects(missing.get('device-token.alpha'), (error) => (
      error.code === 'keychain-item-missing' && !error.message.includes('alpha')
    ));

    const denied = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 36 }),
      service: 'com.linke.test',
    });
    await assert.rejects(denied.set('device-token.alpha', 'do-not-leak'), (error) => (
      error.code === 'keychain-unavailable'
      && error.message === 'keychain-unavailable'
      && !error.message.includes('do-not-leak')
    ));
  });

  it('maps delete exit codes to false, true, or exact keychain-unavailable', async () => {
    const missing = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 44 }),
      service: 'com.linke.test',
    });
    assert.strictEqual(await missing.delete('device-token.alpha'), false);

    const ok = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 0 }),
      service: 'com.linke.test',
    });
    assert.strictEqual(await ok.delete('device-token.alpha'), true);

    const denied = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 36 }),
      service: 'com.linke.test',
    });
    await assert.rejects(denied.delete('device-token.alpha'), (error) => (
      error.code === 'keychain-unavailable' && error.message === 'keychain-unavailable'
    ));
  });

  it('delete uses security -i with delete-generic-password on stdin only', async () => {
    const calls = [];
    const runner = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      return { stdout: '', exitCode: 0 };
    };
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    assert.strictEqual(await store.delete('device-token.alpha'), true);
    assert.deepStrictEqual(calls[0].args, ['-i']);
    const expectedDeleteCmd = 'delete-generic-password -s com.linke.test -a device-token.alpha\n';
    assert.equal(calls[0].input === expectedDeleteCmd, true, 'delete-stdin-cmd-mismatch');
  });

  it('rejects unsafe service and item identifiers before spawning', () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { stdout: '', exitCode: 0 };
    };
    assert.throws(() => new KeychainStore({ runner, service: 'bad service' }));
    assert.strictEqual(calls, 0);
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    assert.throws(() => store.get('../token'));
    assert.strictEqual(calls, 0);
    assert.throws(() => store.set('Bad Id', 'x'));
    assert.strictEqual(calls, 0);
    assert.throws(() => store.delete('../token'));
    assert.strictEqual(calls, 0);
  });

  it('module source must not depend on python helper or CFRelease', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/keychain-store.js'), 'utf8');
    assert.equal(src.includes('python'), false, 'no-python');
    assert.equal(src.includes('keychain-generic-password'), false, 'no-py-helper');
    assert.equal(src.includes('CFRelease'), false, 'no-cfrelease');
    assert.equal(src.includes('/usr/bin/python3'), false, 'no-python-bin');
    // helper file must not exist
    let helperExists = true;
    try {
      readFileSync(join(dir, '../src/keychain-generic-password.py'));
    } catch {
      helperExists = false;
    }
    assert.equal(helperExists, false, 'helper-file-must-be-removed');
  });
});
