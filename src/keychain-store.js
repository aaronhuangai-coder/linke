import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const SAFE_ID = /^[a-z][a-z0-9.-]{1,63}$/;
/** Versioned single-line envelope for arbitrary UTF-8 secrets (including multi-line / NUL). */
const ENVELOPE_PREFIX = 'linke.kc.v1:';
const BASE64URL_BODY = /^[A-Za-z0-9_-]+$/;
/** Max stdout bytes from /usr/bin/security (TLS PEM / token headroom; fail closed above). */
export const MAX_SECURITY_STDOUT_BYTES = 1024 * 1024;
/** Hard wall-clock bound for a headless /usr/bin/security operation. */
export const SECURITY_COMMAND_TIMEOUT_MS = 10_000;

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function unavailableError() {
  return new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
}

/**
 * Encode a non-empty UTF-8 secret as a versioned single-line envelope.
 * @param {string} secret
 * @returns {string}
 */
function encodeEnvelope(secret) {
  return `${ENVELOPE_PREFIX}${Buffer.from(secret, 'utf8').toString('base64url')}`;
}

/**
 * Strip exactly one trailing newline that macOS `security -w` appends.
 * Significant trailing newlines inside envelope payloads are preserved by decoding.
 * @param {string} raw
 * @returns {string}
 */
function stripCliTrailingNewline(raw) {
  if (raw.endsWith('\r\n')) return raw.slice(0, -2);
  if (raw.endsWith('\n')) return raw.slice(0, -1);
  return raw;
}

/**
 * Decode a stored Keychain password value.
 * - New envelopes: exact UTF-8 recovery (multi-line / NUL / trailing newlines).
 * - Legacy plaintext: returned as-is (one CLI newline already stripped).
 * - Prefix present but payload invalid: compatibility — treat as legacy plaintext (no echo).
 * - Empty after CLI strip: unavailable (empty secret is never valid).
 * @param {string} rawStdout
 * @returns {string}
 */
function decodeStoredPassword(rawStdout) {
  const stored = stripCliTrailingNewline(rawStdout);
  if (stored.length === 0) throw unavailableError();

  if (stored.startsWith(ENVELOPE_PREFIX)) {
    const payload = stored.slice(ENVELOPE_PREFIX.length);
    if (payload.length > 0 && BASE64URL_BODY.test(payload)) {
      const buf = Buffer.from(payload, 'base64url');
      // Strict: re-encode must match exactly (rejects non-canonical / corrupt payloads).
      if (buf.toString('base64url') === payload) {
        if (buf.length === 0) throw unavailableError();
        return buf.toString('utf8');
      }
    }
    // Invalid envelope payload → legacy compatibility (do not surface structure errors).
  }
  return stored;
}

/**
 * Constant-time equality for UTF-8 secrets; length mismatch is non-equal without leaking content.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretsEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Best-effort terminate a security child and destroy its stdio streams.
 * Never surfaces kill/destroy errors or stream chunk content.
 * @param {import('node:child_process').ChildProcess | { kill?: Function, stdin?: { destroy?: Function }, stdout?: { destroy?: Function }, stderr?: { destroy?: Function } }} child
 */
function destroySecurityChild(child) {
  try {
    if (child && typeof child.kill === 'function') child.kill();
  } catch {
    // ignore
  }
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    try {
      if (stream && typeof stream.destroy === 'function') stream.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * Create the production /usr/bin/security runner.
 * Production KeychainStore always uses argv `['-i']` and writes interactive commands to stdin.
 * Secret material (including envelope hex) must appear only on stdin — never argv, env, or temp files.
 * String input is encoded into a runner-owned mutable Buffer and best-effort wiped after flush/settle;
 * the source JavaScript string remains non-zeroizable.
 * stderr is consumed and never returned. Sync spawn/end throw, permanent stream error listeners,
 * deferred close success, hard timeout, and oversized stdout all fail closed without leaking system
 * error text, secrets, or chunk content. Kill/close/double stream errors settle only once.
 * @param {{
 *   spawnImpl?: typeof spawn,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout,
 * }} [options]
 * @returns {(args: string[], options?: { input?: string }) => Promise<{ stdout: string, exitCode: number }>}
 */
export function createSecurityRunner({
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  return (args, { input } = {}) => new Promise((resolve, reject) => {
    let settled = false;
    let timeoutActive = false;
    let timeoutHandle;
    let closeObserved = false;
    const stdout = [];
    const sourceStdoutBuffers = [];
    let combinedStdout = null;
    let stdinBuffer = null;
    const wipeMutableBuffer = (buffer) => {
      try {
        if (Buffer.isBuffer(buffer)) buffer.fill(0);
      } catch {
        // 清理保持 best-effort，不能覆盖既有成功或固定失败语义。
      }
    };
    const wipeCapturedStdout = () => {
      for (const buffer of [combinedStdout, ...stdout, ...sourceStdoutBuffers]) {
        wipeMutableBuffer(buffer);
      }
      combinedStdout = null;
      stdout.length = 0;
      sourceStdoutBuffers.length = 0;
    };
    const wipeCapturedStdin = () => {
      wipeMutableBuffer(stdinBuffer);
      stdinBuffer = null;
    };
    const cancelSecurityTimeout = () => {
      if (!timeoutActive) return;
      timeoutActive = false;
      try {
        clearTimeoutImpl(timeoutHandle);
      } catch {
        // ignore
      }
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cancelSecurityTimeout();
      fn();
    };
    const failClosed = () => settle(() => {
      wipeCapturedStdin();
      wipeCapturedStdout();
      reject(unavailableError());
    });

    let child;
    try {
      child = spawnImpl('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      failClosed();
      return;
    }
    let totalStdoutBytes = 0;
    let oversized = false;
    child.stdout.on('data', (chunk) => {
      if (settled || oversized || closeObserved) {
        wipeMutableBuffer(chunk);
        return;
      }
      const buf = Buffer.from(chunk);
      stdout.push(buf);
      if (Buffer.isBuffer(chunk)) sourceStdoutBuffers.push(chunk);
      totalStdoutBytes += buf.length;
      if (totalStdoutBytes > MAX_SECURITY_STDOUT_BYTES) {
        oversized = true;
        destroySecurityChild(child);
        failClosed();
        return;
      }
    });
    child.stderr.resume();
    // Keep error listeners resident so repeated stream errors stay fail-closed.
    child.on('error', failClosed);
    child.stdin.on('error', failClosed);
    child.stdin.once('finish', wipeCapturedStdin);
    child.stdout.on('error', failClosed);
    child.stderr.on('error', failClosed);
    try {
      timeoutHandle = setTimeoutImpl(() => {
        if (!timeoutActive || settled) return;
        failClosed();
        destroySecurityChild(child);
      }, SECURITY_COMMAND_TIMEOUT_MS);
      timeoutActive = true;
      if (settled) cancelSecurityTimeout();
    } catch {
      failClosed();
      destroySecurityChild(child);
      return;
    }
    // Defer successful close so same-turn errors after close win.
    child.once('close', (exitCode) => {
      if (settled || oversized) return;
      closeObserved = true;
      cancelSecurityTimeout();
      wipeCapturedStdin();
      const code = Number.isInteger(exitCode) ? exitCode : 1;
      let out;
      try {
        combinedStdout = Buffer.concat(stdout);
        out = combinedStdout.toString('utf8');
      } catch {
        failClosed();
        return;
      }
      wipeCapturedStdout();
      queueMicrotask(() => settle(() => resolve({ stdout: out, exitCode: code })));
    });
    try {
      if (input === undefined) child.stdin.end();
      else {
        stdinBuffer = Buffer.from(input);
        child.stdin.end(stdinBuffer);
      }
    } catch {
      failClosed();
    }
  });
}

/**
 * Minimal fail-closed generic-password adapter for Linke-owned secrets.
 * Uses official `/usr/bin/security -i` only. Secrets are stored as versioned envelopes
 * via `add-generic-password -U ... -X HEX` on interactive stdin (atomic update, no delete+add).
 * After set, a secure get re-read + constant-time compare validates the write; mismatch is
 * keychain-unavailable and never actively deletes the prior value.
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
    const cmd = `find-generic-password -s ${this.service} -a ${account} -w\n`;
    return this.runner(['-i'], { input: cmd }).then((result) => {
      if (result.exitCode === 44) {
        throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
      }
      if (result.exitCode !== 0) throw unavailableError();
      return decodeStoredPassword(result.stdout);
    });
  }

  /**
   * Upsert a generic-password secret via interactive `add-generic-password -U -X`.
   * Envelope hex is written only on stdin. Never uses find-delete-add.
   * Interactive exit codes alone are not trusted: always re-get and constant-time compare.
   * On any failure, returns keychain-unavailable without actively deleting the prior value.
   * @param {string} itemId
   * @param {string} secret
   * @returns {Promise<void>}
   */
  set(itemId, secret) {
    const account = assertSafeId(itemId, 'itemId');
    if (typeof secret !== 'string' || secret.length === 0) throw new Error('secret is required');
    const envelope = encodeEnvelope(secret);
    const hex = Buffer.from(envelope, 'utf8').toString('hex');
    const cmd = `add-generic-password -U -s ${this.service} -a ${account} -X ${hex}\n`;
    return this.runner(['-i'], { input: cmd }).then(async (result) => {
      if (result.exitCode !== 0) throw unavailableError();
      // Interactive success is unreliable — confirm via secure get + fixed equality.
      let readBack;
      try {
        readBack = await this.get(itemId);
      } catch (error) {
        if (error && error.code === ERROR_CODES.KEYCHAIN_ITEM_MISSING) throw unavailableError();
        throw error;
      }
      if (!secretsEqual(readBack, secret)) throw unavailableError();
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
    const cmd = `delete-generic-password -s ${this.service} -a ${account}\n`;
    return this.runner(['-i'], { input: cmd }).then((result) => {
      if (result.exitCode === 44) return false;
      if (result.exitCode !== 0) throw unavailableError();
      return true;
    });
  }
}
