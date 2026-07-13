import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEVICE_PROTOCOL_VERSION,
  MIN_DEVICE_PROTOCOL_VERSION,
  assertSupportedDeviceProtocol,
} from '../src/device-protocol.js';

describe('device protocol compatibility window', () => {
  it('accepts current and N-1 only', () => {
    assert.strictEqual(DEVICE_PROTOCOL_VERSION, 2);
    assert.strictEqual(MIN_DEVICE_PROTOCOL_VERSION, 1);
    assert.strictEqual(assertSupportedDeviceProtocol(2), 2);
    assert.strictEqual(assertSupportedDeviceProtocol(1), 1);
  });

  it('fails closed for older, future, fractional and string versions', () => {
    for (const version of [0, 3, 1.5, '2', null, undefined, NaN]) {
      assert.throws(
        () => assertSupportedDeviceProtocol(version),
        (error) => (
          error.code === 'device-protocol-unsupported'
          && error.statusCode === 426
          && error.message === 'device-protocol-unsupported'
        ),
      );
    }
  });
});
