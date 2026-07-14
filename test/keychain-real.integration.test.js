import { it } from 'node:test';
import assert from 'node:assert';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { KeychainStore } from '../src/keychain-store.js';

const enabled = process.env.LINKE_REAL_KEYCHAIN_TEST === 'enabled';

/**
 * Secret-safe equality: on mismatch report only a fixed code, never actual/expected values.
 * @param {string} actual
 * @param {string} expected
 * @param {string} code
 */
function assertSecretEqual(actual, expected, code = 'round-trip-mismatch') {
  const a = Buffer.from(String(actual), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  const ok = a.length === b.length && timingSafeEqual(a, b);
  assert.equal(ok, true, code);
}

it('real keychain create/update/get/delete/missing with fixed boolean diagnostics', { skip: !enabled }, async () => {
  const suffix = randomBytes(8).toString('hex');
  const store = new KeychainStore({ service: `com.linke.test.${suffix}` });
  const itemId = `integration.${suffix}`;
  // Multi-line + trailing content; never logged on failure.
  const valueCreate = `${randomBytes(32).toString('base64url')}\nline-two.${suffix}\nline-three-end`;
  const valueUpdate = `${randomBytes(32).toString('base64url')}\nupdated.${suffix}\nwith${String.fromCharCode(0)}nul`;
  try {
    // create
    await store.set(itemId, valueCreate);
    assertSecretEqual(await store.get(itemId), valueCreate, 'create-get-mismatch');
    // update old → new (atomic -U path; must be exact)
    await store.set(itemId, valueUpdate);
    assertSecretEqual(await store.get(itemId), valueUpdate, 'update-get-mismatch');
    // delete present
    assert.equal(await store.delete(itemId), true, 'delete-present-false');
  } finally {
    // Any failure path: always attempt cleanup of the random independent item.
    try {
      await store.delete(itemId);
    } catch {
      // cleanup best-effort; do not leak error text
    }
  }
  // missing get
  await assert.rejects(
    store.get(itemId),
    (error) => error.code === 'keychain-item-missing' && error.message === 'keychain-item-missing',
  );
  // missing delete is idempotent false
  assert.equal(await store.delete(itemId), false, 'delete-missing-not-false');
});
