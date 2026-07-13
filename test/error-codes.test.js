import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../src/error-codes.js';

describe('Gold error-code registry', () => {
  it('contains unique registered kebab-case codes', () => {
    assert.ok(Object.isFrozen(ERROR_CODES));
    const values = Object.values(ERROR_CODES);
    assert.strictEqual(new Set(values).size, values.length);
    for (const code of values) {
      assert.match(code, /^(auth|device|upload|snapshot|smb|restore|retention|scheduler|lifecycle|keychain|audit|upgrade)-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
    }
  });

  it('rejects raw or unregistered error text', () => {
    assert.throws(() => assertRegisteredErrorCode('ENOENT /Users/private'), /unregistered Linke error code/);
  });

  it('rejects unregistered raw text in LinkeError without echoing it', () => {
    const raw = 'ENOENT /Users/private/secret';
    assert.throws(
      () => new LinkeError(raw),
      (error) => {
        assert.match(error.message, /unregistered Linke error code/);
        assert.ok(!error.message.includes(raw));
        assert.ok(!error.message.includes('/Users/private'));
        return true;
      },
    );
  });

  it('constructs a sanitized LinkeError', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
    assert.strictEqual(error.code, 'device-revoked');
    assert.strictEqual(error.message, 'device-revoked');
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.retryable, false);
  });

  it('defaults LinkeError statusCode, retryable, and name', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
    assert.strictEqual(error.name, 'LinkeError');
    assert.strictEqual(error.statusCode, 500);
    assert.strictEqual(error.retryable, false);
  });

  it('preserves retryable true when explicitly set', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_RATE_LIMITED, { statusCode: 429, retryable: true });
    assert.strictEqual(error.retryable, true);
    assert.strictEqual(error.statusCode, 429);
  });
});
