import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagementAuthRotationError,
  stageManagementAuthKeychainRotation,
} from '../src/management-auth-rotation.js';

describe('management auth rotation public contract skeleton', () => {
  it('exports the staging entry and fixed non-secret error class', () => {
    assert.equal(typeof stageManagementAuthKeychainRotation, 'function');
    const error = new ManagementAuthRotationError();
    assert.equal(error.name, 'ManagementAuthRotationError');
    assert.equal(error.code, 'management-auth-rotation-invalid');
    assert.equal(error.message, 'management-auth-rotation-invalid');
  });

  it('maps unknown error codes to fixed invalid without echoing input', () => {
    const sentinel = 'secret-error-code-sentinel';
    const error = new ManagementAuthRotationError(sentinel);
    assert.equal(error.code, 'management-auth-rotation-invalid');
    assert.equal(error.message, 'management-auth-rotation-invalid');
    assert.doesNotMatch(`${error.name}\n${error.code}\n${error.message}`, /secret-error-code-sentinel/);
  });

  it('fails closed on invalid input before lock or Keychain access', async () => {
    let touches = 0;
    await assert.rejects(
      stageManagementAuthKeychainRotation({
        keychain: {
          get() { touches += 1; },
          set() { touches += 1; },
        },
        withExclusiveLock() { touches += 1; },
      }),
      (error) => error instanceof ManagementAuthRotationError
        && error.code === 'management-auth-rotation-invalid'
        && error.message === 'management-auth-rotation-invalid',
    );
    assert.equal(touches, 0);
  });
});
