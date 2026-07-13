import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createSecurityRunner, KeychainStore } from '../src/keychain-store.js';

/**
 * Build a fake child_process-compatible spawn for createSecurityRunner tests.
 * Never invokes /usr/bin/security.
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
      // Emit after the runner has installed listeners (same turn ends after end()).
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

describe('createSecurityRunner', () => {
  it('locks binary, stdio, args and sends secret only via stdin with trailing newline', async () => {
    const secret = 'runner-stdin-secret';
    const { spawnImpl, calls } = createFakeSpawn({ closeCode: 0, stdoutData: '' });
    const runner = createSecurityRunner({ spawnImpl });
    const args = [
      'add-generic-password', '-U', '-s', 'com.linke.test',
      '-a', 'device-token.alpha', '-w',
    ];
    const result = await runner(args, { input: secret });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].binary, '/usr/bin/security');
    assert.deepStrictEqual(calls[0].options, { stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepStrictEqual(calls[0].args, args);
    assert.ok(!calls[0].args.includes(secret));
    assert.ok(!calls[0].args.join(' ').includes(secret));
    assert.deepStrictEqual(calls[0].stdinChunks, [`${secret}\n`]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, '');
  });

  it('collects stdout and never surfaces stderr content in result or errors', async () => {
    const { spawnImpl, calls } = createFakeSpawn({
      closeCode: 0,
      stdoutData: 'stored-from-stdout',
      stderrData: 'stderr-must-not-leak',
    });
    const runner = createSecurityRunner({ spawnImpl });
    const result = await runner(['find-generic-password', '-s', 'com.linke.test', '-a', 'item', '-w']);
    assert.strictEqual(calls[0].binary, '/usr/bin/security');
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
      runner(['find-generic-password', '-s', 'com.linke.test', '-a', 'item', '-w']),
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
      runner(
        ['find-generic-password', '-s', 'com.linke.test', '-a', 'item', '-w'],
        { input: probeSecret },
      ),
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
    const result = await runner(['find-generic-password', '-s', 'com.linke.test', '-a', 'item', '-w']);
    assert.strictEqual(result.exitCode, 1);
  });

  it('rejects stdin error including EPIPE as keychain-unavailable without leaking system text', async () => {
    const epiped = new Error('write EPIPE');
    epiped.code = 'EPIPE';
    const { spawnImpl } = createFakeSpawn({ stdinError: epiped });
    const runner = createSecurityRunner({ spawnImpl });
    await assert.rejects(
      runner(
        ['add-generic-password', '-U', '-s', 'com.linke.test', '-a', 'item', '-w'],
        { input: 'must-not-leak-on-epipe' },
      ),
      (error) => (
        error.name === 'LinkeError'
        && error.code === 'keychain-unavailable'
        && error.message === 'keychain-unavailable'
        && !error.message.includes('EPIPE')
        && !error.message.includes('must-not-leak-on-epipe')
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
      runner(
        ['add-generic-password', '-U', '-s', 'com.linke.test', '-a', 'item', '-w'],
        { input: probeSecret },
      ),
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
      runner(
        ['add-generic-password', '-U', '-s', 'com.linke.test', '-a', 'item', '-w'],
        { input: probeSecret },
      ),
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
        runner(
          ['add-generic-password', '-U', '-s', 'com.linke.test', '-a', 'item', '-w'],
          { input: probeSecret },
        ),
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
      runner(
        ['find-generic-password', '-s', 'com.linke.test', '-a', 'item', '-w'],
        { input: probeSecret },
      ),
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
      runner(
        ['find-generic-password', '-s', 'com.linke.test', '-a', 'item', '-w'],
        { input: probeSecret },
      ),
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

  it('writes secret only as stdin payload with trailing newline', async () => {
    const secret = 'stdin-only-secret-value';
    let written;
    const spawnImpl = (binary, args, options) => {
      assert.strictEqual(binary, '/usr/bin/security');
      assert.deepStrictEqual(options, { stdio: ['pipe', 'pipe', 'pipe'] });
      assert.ok(!args.includes(secret));
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
    await runner(
      ['add-generic-password', '-U', '-s', 'com.linke.test', '-a', 'device-token.alpha', '-w'],
      { input: secret },
    );
    assert.strictEqual(written, `${secret}\n`);
  });
});

describe('KeychainStore', () => {
  it('writes through stdin and never places the secret in argv', async () => {
    const calls = [];
    const runner = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      return { stdout: '', exitCode: 0 };
    };
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    await store.set('device-token.alpha', 'test-secret-value');
    assert.deepStrictEqual(calls[0].args, [
      'add-generic-password', '-U', '-s', 'com.linke.test',
      '-a', 'device-token.alpha', '-w',
    ]);
    assert.strictEqual(calls[0].input, 'test-secret-value');
    assert.ok(!calls[0].args.join(' ').includes('test-secret-value'));
  });

  it('returns stdout only from a successful lookup', async () => {
    const runner = async () => ({ stdout: 'stored-value\n', exitCode: 0 });
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    assert.strictEqual(await store.get('device-token.alpha'), 'stored-value');
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
});
