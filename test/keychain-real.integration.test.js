import { it } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { KeychainStore } from '../src/keychain-store.js';

const enabled = process.env.LINKE_REAL_KEYCHAIN_TEST === 'enabled';

it('round-trips a dedicated real macOS Keychain item', { skip: !enabled }, async () => {
  const suffix = randomBytes(8).toString('hex');
  const store = new KeychainStore({ service: `com.linke.test.${suffix}` });
  const itemId = `integration.${suffix}`;
  const value = randomBytes(32).toString('base64url');
  try {
    await store.set(itemId, value);
    assert.strictEqual(await store.get(itemId), value);
  } finally {
    await store.delete(itemId);
  }
  await assert.rejects(store.get(itemId), (error) => error.code === 'keychain-item-missing');
});
