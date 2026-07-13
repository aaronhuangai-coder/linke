import { spawn } from 'node:child_process';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const SAFE_ID = /^[a-z][a-z0-9.-]{1,63}$/;

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function unavailableError() {
  return new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
}

/**
 * Create the production /usr/bin/security runner.
 * Secret input is written only to stdin; stderr is consumed and never returned.
 * Sync spawn/end throw, permanent stream error listeners, and deferred close
 * success all fail closed without leaking system error text or secrets.
 * @param {{ spawnImpl?: typeof spawn }} [options]
 * @returns {(args: string[], options?: { input?: string }) => Promise<{ stdout: string, exitCode: number }>}
 */
export function createSecurityRunner({ spawnImpl = spawn } = {}) {
  return (args, { input } = {}) => new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const failClosed = () => settle(() => reject(unavailableError()));

    let child;
    try {
      child = spawnImpl('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      failClosed();
      return;
    }
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    // Keep error listeners resident so repeated stream errors stay fail-closed.
    child.on('error', failClosed);
    child.stdin.on('error', failClosed);
    child.stdout.on('error', failClosed);
    child.stderr.on('error', failClosed);
    // Defer successful close so same-turn errors after close win.
    child.once('close', (exitCode) => {
      const code = Number.isInteger(exitCode) ? exitCode : 1;
      const out = Buffer.concat(stdout).toString('utf8');
      queueMicrotask(() => settle(() => resolve({ stdout: out, exitCode: code })));
    });
    try {
      if (input === undefined) child.stdin.end();
      else child.stdin.end(`${input}\n`);
    } catch {
      failClosed();
    }
  });
}

/**
 * Minimal fail-closed generic-password adapter for Linke-owned secrets.
 * Secrets never appear in argv, stderr, exception text, or logs.
 */
export class KeychainStore {
  /**
   * @param {{ runner?: Function, service?: string }} [options]
   */
  constructor({ runner = createSecurityRunner(), service = 'com.linke.gold' } = {}) {
    this.runner = runner;
    this.service = assertSafeId(service, 'service');
  }

  /**
   * Read a generic-password secret by item id.
   * Invalid ids throw synchronously before any subprocess is spawned.
   * @param {string} itemId
   * @returns {Promise<string>}
   */
  get(itemId) {
    const account = assertSafeId(itemId, 'itemId');
    return this.runner([
      'find-generic-password', '-s', this.service, '-a', account, '-w',
    ]).then((result) => {
      if (result.exitCode === 44) {
        throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
      }
      if (result.exitCode !== 0) throw unavailableError();
      return result.stdout.replace(/\r?\n$/, '');
    });
  }

  /**
   * Upsert a generic-password secret; value is sent only via runner stdin.
   * Invalid ids/secret throw synchronously before any subprocess is spawned.
   * @param {string} itemId
   * @param {string} secret
   * @returns {Promise<void>}
   */
  set(itemId, secret) {
    const account = assertSafeId(itemId, 'itemId');
    if (typeof secret !== 'string' || secret.length === 0) throw new Error('secret is required');
    return this.runner([
      'add-generic-password', '-U', '-s', this.service, '-a', account, '-w',
    ], { input: secret }).then((result) => {
      if (result.exitCode !== 0) throw unavailableError();
    });
  }

  /**
   * Delete a generic-password item. Missing item (exit 44) returns false.
   * Invalid ids throw synchronously before any subprocess is spawned.
   * @param {string} itemId
   * @returns {Promise<boolean>}
   */
  delete(itemId) {
    const account = assertSafeId(itemId, 'itemId');
    return this.runner([
      'delete-generic-password', '-s', this.service, '-a', account,
    ]).then((result) => {
      if (result.exitCode === 44) return false;
      if (result.exitCode !== 0) throw unavailableError();
      return true;
    });
  }
}
