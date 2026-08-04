/**
 * Task 1 RED — audit integrity alert delivery claim-state contract.
 * Authority:
 *   docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-claim-design.md
 *   docs/superpowers/plans/2026-08-04-audit-integrity-alert-delivery-claim-plan.md
 *
 * Production (not present on this HEAD):
 *   src/audit-integrity-alert-delivery-claim-state.js
 *
 * Real temp fixtures + real enqueueAuditIntegrityWriteTask leases.
 * No mocks for core state / read / write / lease behavior.
 * Old-HEAD RED is behavior-specific: "claim state implementation missing".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-claim-state.js',
  import.meta.url,
);
const MISSING_MSG = 'claim state implementation missing';

const RELATIVE_PATH = 'audit/integrity-alert-delivery-claim.json';

const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'claimId',
  'streamId',
  'sequence',
  'ownerPid',
  'bootSessionIdentity',
  'processStartIdentity',
  'claimedAt',
  'expiresAt',
]);
const IDENTITY_KEYS = Object.freeze(['available', 'value']);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CLAIM_ID = 'a1111111-b111-4111-8111-e11111111111';
const STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const SEQUENCE = 7;
const OWNER_PID = 4242;
const BOOT_VALUE =
  'boot-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROCESS_VALUE =
  'process-start-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CLAIMED_AT = '2026-08-04T12:00:00.000Z';
const EXPIRES_AT = '2026-08-04T12:02:00.000Z';

/** Exact literal canonical idle bytes (one compact object + exactly one trailing newline). */
const CANONICAL_IDLE_BYTES =
  '{"schemaVersion":1,"status":"idle","claimId":null,"streamId":null,"sequence":null,"ownerPid":null,"bootSessionIdentity":null,"processStartIdentity":null,"claimedAt":null,"expiresAt":null}\n';

/** Exact literal canonical claimed bytes (hand-derived fixtures, one trailing newline). */
const CANONICAL_CLAIMED_BYTES =
  '{"schemaVersion":1,"status":"claimed","claimId":"a1111111-b111-4111-8111-e11111111111","streamId":"b2222222-c222-4222-9222-f22222222222","sequence":7,"ownerPid":4242,"bootSessionIdentity":{"available":true,"value":"boot-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"processStartIdentity":{"available":true,"value":"process-start-sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"claimedAt":"2026-08-04T12:00:00.000Z","expiresAt":"2026-08-04T12:02:00.000Z"}\n';

const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

/** @type {null | {
 *   AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH: string,
 *   AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES: number,
 *   loadAuditIntegrityAlertDeliveryClaimState: Function,
 *   publishAuditIntegrityAlertDeliveryClaimState: Function,
 *   assertNoAuditIntegrityAlertDeliveryClaim: Function,
 * }} */
let claimApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.loadAuditIntegrityAlertDeliveryClaimState === 'function'
    && typeof mod.publishAuditIntegrityAlertDeliveryClaimState === 'function'
    && typeof mod.assertNoAuditIntegrityAlertDeliveryClaim === 'function'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH === 'string'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES === 'number'
  ) {
    claimApi = {
      AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH:
        mod.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
      AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES:
        mod.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES,
      loadAuditIntegrityAlertDeliveryClaimState:
        mod.loadAuditIntegrityAlertDeliveryClaimState,
      publishAuditIntegrityAlertDeliveryClaimState:
        mod.publishAuditIntegrityAlertDeliveryClaimState,
      assertNoAuditIntegrityAlertDeliveryClaim:
        mod.assertNoAuditIntegrityAlertDeliveryClaim,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    claimApi = null;
  } else {
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || claimApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof claimApi>} */ (claimApi);
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-claim-state-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function claimAbs(root) {
  return join(root, RELATIVE_PATH);
}

function buildIdleObject() {
  return {
    schemaVersion: 1,
    status: 'idle',
    claimId: null,
    streamId: null,
    sequence: null,
    ownerPid: null,
    bootSessionIdentity: null,
    processStartIdentity: null,
    claimedAt: null,
    expiresAt: null,
  };
}

function buildClaimedObject(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'claimed',
    claimId: CLAIM_ID,
    streamId: STREAM_ID,
    sequence: SEQUENCE,
    ownerPid: OWNER_PID,
    bootSessionIdentity: { available: true, value: BOOT_VALUE },
    processStartIdentity: { available: true, value: PROCESS_VALUE },
    claimedAt: CLAIMED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function reorderKeys(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of Object.keys(value)) {
    assertDeeplyFrozen(value[key], `${path}.${key}`);
  }
}

/**
 * All public-boundary failures use path-free audit-delivery-unavailable.
 * Catches raw errno / path / secret leakage that would break delivery fail-closed.
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(
    error && /** @type {{ code?: string }} */ (error).code,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    /** @type {{ message: string }} */ (error).message,
    /** @type {{ code: string }} */ (error).code,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  for (const token of [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ELOOP',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'SECRET',
    'integrity-alert-delivery-claim',
    ...leakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `must not leak ${token}`);
  }
  return true;
}

function assertIdleShape(state) {
  assert.deepEqual(Object.keys(state), [...TOP_KEYS]);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.status, 'idle');
  assert.equal(state.claimId, null);
  assert.equal(state.streamId, null);
  assert.equal(state.sequence, null);
  assert.equal(state.ownerPid, null);
  assert.equal(state.bootSessionIdentity, null);
  assert.equal(state.processStartIdentity, null);
  assert.equal(state.claimedAt, null);
  assert.equal(state.expiresAt, null);
  assertDeeplyFrozen(state);
}

function assertClaimedShape(state) {
  assert.deepEqual(Object.keys(state), [...TOP_KEYS]);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.status, 'claimed');
  assert.equal(state.claimId, CLAIM_ID);
  assert.equal(state.streamId, STREAM_ID);
  assert.match(state.claimId, UUID_V4_RE);
  assert.match(state.streamId, UUID_V4_RE);
  assert.equal(state.sequence, SEQUENCE);
  assert.equal(state.ownerPid, OWNER_PID);
  assert.equal(Number.isSafeInteger(state.sequence) && state.sequence > 0, true);
  assert.equal(Number.isSafeInteger(state.ownerPid) && state.ownerPid > 0, true);
  assert.deepEqual(Object.keys(state.bootSessionIdentity), [...IDENTITY_KEYS]);
  assert.deepEqual(Object.keys(state.processStartIdentity), [...IDENTITY_KEYS]);
  assert.equal(state.bootSessionIdentity.available, true);
  assert.equal(state.processStartIdentity.available, true);
  assert.equal(state.bootSessionIdentity.value, BOOT_VALUE);
  assert.equal(state.processStartIdentity.value, PROCESS_VALUE);
  assert.equal(typeof state.bootSessionIdentity.value, 'string');
  assert.equal(state.bootSessionIdentity.value.length > 0, true);
  assert.equal(state.bootSessionIdentity.value.includes('/'), false);
  assert.equal(state.bootSessionIdentity.value.includes('\\'), false);
  assert.equal(state.claimedAt, CLAIMED_AT);
  assert.equal(state.expiresAt, EXPIRES_AT);
  assert.match(state.claimedAt, MS_UTC_RE);
  assert.match(state.expiresAt, MS_UTC_RE);
  assert.equal(new Date(state.claimedAt).toISOString(), state.claimedAt);
  assert.equal(new Date(state.expiresAt).toISOString(), state.expiresAt);
  assert.equal(Date.parse(state.claimedAt) < Date.parse(state.expiresAt), true);
  assertDeeplyFrozen(state);
}

// Anchor hand-derived literals so fixtures cannot drift silently.
// Max-byte fit is asserted against the runtime export once the module exists (no invented constant).
assert.equal(
  CANONICAL_IDLE_BYTES,
  `${JSON.stringify(buildIdleObject())}\n`,
);
assert.equal(
  CANONICAL_CLAIMED_BYTES,
  `${JSON.stringify(buildClaimedObject())}\n`,
);
assert.equal(Date.parse(EXPIRES_AT) - Date.parse(CLAIMED_AT), 120_000);
assert.match(CLAIM_ID, UUID_V4_RE);
assert.match(STREAM_ID, UUID_V4_RE);

describe('audit integrity alert delivery claim state (Task 1 RED)', () => {
  // Old-HEAD: exactly one dedicated RED. Full behavioral matrix registers only when exports exist.
  if (implementationMissing || claimApi === null) {
    it('claim state implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  it('exports relative path and fixed positive max byte bound as consumer-visible constants', async () => {
    // Break: missing/wrong exported path or max-bytes would misplace claim leaf or accept oversize.
    const api = requireApi();
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
      RELATIVE_PATH,
    );
    const maxBytes = api.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES;
    assert.equal(
      Number.isSafeInteger(maxBytes) && maxBytes > 0,
      true,
    );
    assert.equal(
      Buffer.byteLength(CANONICAL_IDLE_BYTES, 'utf8') <= maxBytes,
      true,
    );
    assert.equal(
      Buffer.byteLength(CANONICAL_CLAIMED_BYTES, 'utf8') <= maxBytes,
      true,
    );
    assert.equal(typeof api.loadAuditIntegrityAlertDeliveryClaimState, 'function');
    assert.equal(typeof api.publishAuditIntegrityAlertDeliveryClaimState, 'function');
    assert.equal(typeof api.assertNoAuditIntegrityAlertDeliveryClaim, 'function');
  });

  it('publish idle writes exact canonical idle bytes mode 0600 and returns deep-frozen exact-key copy', async () => {
    // Break: non-canonical serialization, wrong mode, mutable return, or key drift corrupt fencing.
    const api = requireApi();
    await withTempRoot('idle-publish', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const published = await api.publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          buildIdleObject(),
        );
        assertIdleShape(published);
        assert.notEqual(published, buildIdleObject());
        assert.throws(() => {
          published.status = 'claimed';
        }, TypeError);
        assert.equal(published.status, 'idle');
      });
      const raw = await readFile(claimAbs(root), 'utf8');
      assert.equal(raw, CANONICAL_IDLE_BYTES);
      assert.equal(raw.endsWith('\n'), true);
      assert.equal(raw.endsWith('\n\n'), false);
      assert.equal(raw.slice(0, -1).includes('\n'), false);
      const st = await lstat(claimAbs(root));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  it('publish claimed writes exact canonical claimed bytes and exact post-write raw readback', async () => {
    // Break: non-canonical claimed fields, missing post-write readback, or mutable nested identities.
    const api = requireApi();
    await withTempRoot('claimed-publish', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const input = buildClaimedObject();
        const published = await api.publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          input,
        );
        assertClaimedShape(published);
        assert.notEqual(published, input);
        assert.notEqual(published.bootSessionIdentity, input.bootSessionIdentity);
        input.claimId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
        input.bootSessionIdentity.value = 'mutated';
        assert.equal(published.claimId, CLAIM_ID);
        assert.equal(published.bootSessionIdentity.value, BOOT_VALUE);

        const loaded = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assertClaimedShape(loaded);
        assert.deepEqual(loaded, published);
        assert.notEqual(loaded, published);
      });
      const raw = await readFile(claimAbs(root), 'utf8');
      assert.equal(raw, CANONICAL_CLAIMED_BYTES);
      const st = await lstat(claimAbs(root));
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  it('load missing leaf returns canonical idle without creating the file', async () => {
    // Break: treating missing as error, auto-creating claim leaf, or returning null breaks residual recovery.
    const api = requireApi();
    await withTempRoot('load-missing', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assertIdleShape(loaded);
        assert.equal(JSON.stringify(loaded) + '\n', CANONICAL_IDLE_BYTES);
      });
      // Claim leaf must stay absent; process-lock protocol may create audit parent/artifacts.
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });
  });

  it('load hand-written exact idle and claimed bytes returns deep-frozen exact-key copies', async () => {
    // Break: accepting only publish-produced objects or shallow freeze allows caller mutation of shared state.
    const api = requireApi();
    await withTempRoot('load-hand-raw', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(claimAbs(root), CANONICAL_IDLE_BYTES, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        const idle = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assertIdleShape(idle);
        assert.throws(() => {
          idle.status = 'claimed';
        }, TypeError);
        const idleAgain = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assert.equal(idleAgain.status, 'idle');
        assert.notEqual(idleAgain, idle);
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_BYTES);

      await writeFile(claimAbs(root), CANONICAL_CLAIMED_BYTES, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        const claimed = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assertClaimedShape(claimed);
        assert.throws(() => {
          claimed.sequence = 99;
        }, TypeError);
        assert.throws(() => {
          claimed.bootSessionIdentity.value = 'mutated';
        }, TypeError);
        const claimedAgain = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assert.equal(claimedAgain.sequence, SEQUENCE);
        assert.equal(claimedAgain.bootSessionIdentity.value, BOOT_VALUE);
        assert.notEqual(claimedAgain, claimed);
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_CLAIMED_BYTES);
    });
  });

  it('assertNo accepts missing or canonical idle and rejects canonical claimed without mutation', async () => {
    // Break: treating idle as occupied, or allowing claimed through, would open manual-ack bypass.
    const api = requireApi();
    await withTempRoot('assert-no-missing', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const signal = await api.assertNoAuditIntegrityAlertDeliveryClaim(
          resolvedRoot,
          lease,
        );
        assert.equal(signal, undefined);
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('assert-no-idle', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(claimAbs(root), CANONICAL_IDLE_BYTES, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        const signal = await api.assertNoAuditIntegrityAlertDeliveryClaim(
          resolvedRoot,
          lease,
        );
        assert.equal(signal, undefined);
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_BYTES);
    });

    await withTempRoot('assert-no-claimed', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(claimAbs(root), CANONICAL_CLAIMED_BYTES, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, claimAbs(root), CLAIM_ID, STREAM_ID]),
        );
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_CLAIMED_BYTES);
    });
  });

  it('rejects oversize, BOM, duplicate/extra/missing/reordered keys, whitespace, alternate escapes, extra newline, trailing garbage, and invalid JSON', async () => {
    // Break: loose JSON grammar would allow dual interpretation of claim fencing bytes.
    const api = requireApi();
    const maxBytes = api.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES;
    assert.equal(Number.isSafeInteger(maxBytes) && maxBytes > 0, true);
    const oversizeRaw = 'x'.repeat(maxBytes + 1);
    assert.equal(Buffer.byteLength(oversizeRaw, 'utf8'), maxBytes + 1);
    const cases = [
      {
        name: 'oversize',
        raw: oversizeRaw,
      },
      {
        name: 'bom',
        raw: `\uFEFF${CANONICAL_IDLE_BYTES}`,
      },
      {
        name: 'duplicate-status-key',
        raw: CANONICAL_IDLE_BYTES.replace(
          '"status":"idle"',
          '"status":"claimed","status":"idle"',
        ),
      },
      {
        name: 'extra-top-key',
        raw: `${JSON.stringify({ ...buildIdleObject(), extra: true })}\n`,
      },
      {
        name: 'missing-top-key',
        raw: `${JSON.stringify((() => {
          const o = buildIdleObject();
          delete o.expiresAt;
          return o;
        })())}\n`,
      },
      {
        name: 'reordered-top-keys',
        raw: `${JSON.stringify(reorderKeys(buildIdleObject(), [
          'status',
          'schemaVersion',
          'claimId',
          'streamId',
          'sequence',
          'ownerPid',
          'bootSessionIdentity',
          'processStartIdentity',
          'claimedAt',
          'expiresAt',
        ]))}\n`,
      },
      {
        name: 'pretty-whitespace',
        raw: `${JSON.stringify(buildIdleObject(), null, 2)}\n`,
      },
      {
        name: 'space-after-colon',
        raw: CANONICAL_IDLE_BYTES.replace(':', ': '),
      },
      {
        name: 'tab-after-comma',
        raw: CANONICAL_IDLE_BYTES.replace(',', ',\t'),
      },
      {
        name: 'unicode-escape-status',
        raw: CANONICAL_IDLE_BYTES.replace('"status":"idle"', '"status":"\\u0069dle"'),
      },
      {
        name: 'extra-newline',
        raw: `${CANONICAL_IDLE_BYTES}\n`,
      },
      {
        name: 'missing-trailing-newline',
        raw: CANONICAL_IDLE_BYTES.slice(0, -1),
      },
      {
        name: 'trailing-garbage',
        raw: `${CANONICAL_IDLE_BYTES.slice(0, -1)} trailing\n`,
      },
      {
        name: 'invalid-json',
        raw: '{not-json\n',
      },
      {
        name: 'empty',
        raw: '',
      },
      {
        name: 'reordered-identity-keys',
        raw: `${JSON.stringify(buildClaimedObject({
          bootSessionIdentity: { value: BOOT_VALUE, available: true },
        }))}\n`,
      },
      {
        name: 'extra-identity-key',
        raw: `${JSON.stringify(buildClaimedObject({
          bootSessionIdentity: { available: true, value: BOOT_VALUE, extra: 1 },
        }))}\n`,
      },
    ];

    for (const { name, raw } of cases) {
      await withTempRoot(`raw-${name}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(claimAbs(root), raw, { mode: 0o600 });
        const before = await readFile(claimAbs(root));
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
            (error) => assertUnavailable(error, [
              root,
              claimAbs(root),
              raw.slice(0, 48),
              'not-json',
              'trailing',
            ]),
          );
          await assert.rejects(
            () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease),
            (error) => assertUnavailable(error, [root, claimAbs(root)]),
          );
        });
        assert.deepEqual(await readFile(claimAbs(root)), before);
      });
    }

    // Publish boundary: a payload whose serialized form is at least exported-max+1 fails closed.
    // Identity digests have no separate approved length cap; overall max still binds.
    await withTempRoot('publish-oversize-payload', async (root) => {
      const hugeValue = 'x'.repeat(maxBytes + 1);
      assert.equal(Buffer.byteLength(hugeValue, 'utf8'), maxBytes + 1);
      const oversizePayload = buildClaimedObject({
        bootSessionIdentity: { available: true, value: hugeValue },
      });
      assert.equal(
        Buffer.byteLength(`${JSON.stringify(oversizePayload)}\n`, 'utf8') > maxBytes,
        true,
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            oversizePayload,
          ),
          (error) => assertUnavailable(error, [root, claimAbs(root)]),
        );
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    // Semantic-legal after JSON.parse last-wins still rejected by raw identity.
    assert.equal(
      JSON.parse(
        CANONICAL_IDLE_BYTES.replace(
          '"status":"idle"',
          '"status":"claimed","status":"idle"',
        ),
      ).status,
      'idle',
    );
    assert.equal(
      JSON.parse(CANONICAL_IDLE_BYTES.replace('"status":"idle"', '"status":"\\u0069dle"')).status,
      'idle',
    );
  });

  it('rejects unsafe sequence/pid/uuid/timestamp/status values and non-null idle fields', async () => {
    // Break: unsafe numbers or noncanonical UUID/time would fence wrong owners or accept ambiguous claims.
    const api = requireApi();
    const invalidClaimed = [
      buildClaimedObject({ sequence: 0 }),
      buildClaimedObject({ sequence: -1 }),
      buildClaimedObject({ sequence: 1.5 }),
      buildClaimedObject({ sequence: Number.NaN }),
      buildClaimedObject({ sequence: Number.POSITIVE_INFINITY }),
      buildClaimedObject({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      buildClaimedObject({ ownerPid: 0 }),
      buildClaimedObject({ ownerPid: -3 }),
      buildClaimedObject({ ownerPid: 3.14 }),
      buildClaimedObject({ claimId: CLAIM_ID.toUpperCase() }),
      buildClaimedObject({ claimId: '11111111-1111-1111-8111-111111111111' }),
      buildClaimedObject({ claimId: 'a1111111-b111-4111-c111-e11111111111' }),
      buildClaimedObject({ streamId: STREAM_ID.toUpperCase() }),
      buildClaimedObject({ streamId: 'not-a-uuid' }),
      buildClaimedObject({ claimedAt: '2026-08-04T12:00:00Z' }),
      buildClaimedObject({ claimedAt: '2026-08-04 12:00:00.000Z' }),
      buildClaimedObject({ claimedAt: '2026-08-04T12:00:00.000+00:00' }),
      buildClaimedObject({ expiresAt: '2026-08-04T12:02:00.000' }),
      buildClaimedObject({ claimedAt: EXPIRES_AT, expiresAt: CLAIMED_AT }),
      buildClaimedObject({ claimedAt: CLAIMED_AT, expiresAt: CLAIMED_AT }),
      buildClaimedObject({ status: 'busy' }),
      buildClaimedObject({ schemaVersion: 2 }),
      buildClaimedObject({
        bootSessionIdentity: { available: false, value: null },
      }),
      buildClaimedObject({
        bootSessionIdentity: { available: true, value: '' },
      }),
      buildClaimedObject({
        bootSessionIdentity: { available: true, value: '/tmp/hostile-path' },
      }),
      buildClaimedObject({
        processStartIdentity: { available: true, value: 'has\\backslash' },
      }),
      buildClaimedObject({
        processStartIdentity: { available: true, value: 'has\nnewline' },
      }),
      buildClaimedObject({
        bootSessionIdentity: null,
      }),
      buildClaimedObject({
        claimedAt: null,
      }),
      {
        ...buildIdleObject(),
        status: 'idle',
        claimId: CLAIM_ID,
      },
      {
        ...buildIdleObject(),
        sequence: 1,
      },
    ];

    for (const [index, state] of invalidClaimed.entries()) {
      await withTempRoot(`invalid-obj-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryClaimState(
              resolvedRoot,
              lease,
              state,
            ),
            (error) => assertUnavailable(error, [
              root,
              '/tmp/hostile-path',
              'hostile',
              CLAIM_ID,
            ]),
          );
        });
        await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
      });

      // Also reject when already on disk as non-canonical semantic payload.
      // Skip disk load when serialized bytes already exceed the runtime max (oversize path covers that).
      const raw = `${JSON.stringify(state)}\n`;
      const maxBytes = api.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES;
      if (Buffer.byteLength(raw, 'utf8') <= maxBytes) {
        await withTempRoot(`invalid-disk-${index}`, async (root) => {
          await mkdir(join(root, 'audit'), { recursive: true });
          await writeFile(claimAbs(root), raw, { mode: 0o600 });
          const before = await readFile(claimAbs(root));
          await withLease(root, async (resolvedRoot, lease) => {
            await assert.rejects(
              () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
              (error) => assertUnavailable(error, [root, claimAbs(root)]),
            );
          });
          assert.deepEqual(await readFile(claimAbs(root)), before);
        });
      }
    }
  });

  it('rejects hostile Proxy/accessor/symbol/non-enumerable/class/toJSON objects without triggering traps or leaking secrets', async () => {
    // Break: JSON.stringify whitewash or trap execution would accept forged claims or leak secrets.
    const api = requireApi();

    await withTempRoot('proxy-top', async (root) => {
      const target = buildClaimedObject();
      const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
      const proxy = new Proxy(target, {
        get(...args) {
          traps.get += 1;
          return Reflect.get(...args);
        },
        ownKeys(...args) {
          traps.ownKeys += 1;
          return Reflect.ownKeys(...args);
        },
        getOwnPropertyDescriptor(...args) {
          traps.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(...args);
        },
        getPrototypeOf(...args) {
          traps.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(...args);
        },
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            proxy,
          ),
          (error) => assertUnavailable(error, [root, 'SECRET']),
        );
      });
      assert.deepEqual(traps, {
        get: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
        getPrototypeOf: 0,
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('proxy-identity', async (root) => {
      const state = buildClaimedObject();
      state.bootSessionIdentity = new Proxy(
        { available: true, value: BOOT_VALUE },
        {
          get() {
            throw new Error('SECRET /tmp/trap-get');
          },
        },
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            state,
          ),
          (error) => assertUnavailable(error, [root, 'SECRET', '/tmp/trap-get']),
        );
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('accessor-identity', async (root) => {
      let getterHits = 0;
      const withAccessor = {};
      Object.defineProperty(withAccessor, 'available', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return true;
        },
      });
      Object.defineProperty(withAccessor, 'value', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return BOOT_VALUE;
        },
      });
      const state = buildClaimedObject({ bootSessionIdentity: withAccessor });
      // Prove stringify would whitewash accessors into plain data.
      assert.deepEqual(
        JSON.parse(JSON.stringify(state)).bootSessionIdentity,
        { available: true, value: BOOT_VALUE },
      );
      // Isolate test-origin getter hits from production; final zero asserts production only.
      assert.equal(getterHits, 2, 'stringify demonstration exercises both accessors');
      getterHits = 0;
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            state,
          ),
          (error) => assertUnavailable(error, [root]),
        );
      });
      assert.equal(getterHits, 0, 'accessor getters must not run');
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('symbol-and-nonenum', async (root) => {
      const secretSym = Symbol('secret-path-/tmp/leak');
      const withSymbol = buildClaimedObject();
      withSymbol[secretSym] = '/tmp/secret-claim-path';
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            withSymbol,
          ),
          (error) => {
            assertUnavailable(error, [root, 'secret', '/tmp']);
            return true;
          },
        );
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });

      const nonEnum = buildClaimedObject();
      Object.defineProperty(nonEnum, 'secret', {
        value: 'SECRET_NONENUM /tmp/path',
        enumerable: false,
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            nonEnum,
          ),
          (error) => {
            assertUnavailable(error, [root, 'SECRET_NONENUM', '/tmp/path']);
            return true;
          },
        );
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('class-tojson', async (root) => {
      class HostileIdentity {
        toJSON() {
          return { available: true, value: BOOT_VALUE };
        }
      }
      const state = buildClaimedObject();
      state.bootSessionIdentity = new HostileIdentity();
      assert.deepEqual(
        JSON.parse(JSON.stringify(state)).bootSessionIdentity,
        { available: true, value: BOOT_VALUE },
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            state,
          ),
          (error) => assertUnavailable(error, [root, BOOT_VALUE]),
        );
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });

      const withToJson = {
        available: true,
        value: BOOT_VALUE,
        toJSON() {
          return { available: true, value: 'whitewashed-value' };
        },
      };
      const state2 = buildClaimedObject({ bootSessionIdentity: withToJson });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            state2,
          ),
          (error) => assertUnavailable(error, [root, 'whitewashed-value']),
        );
      });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });
  });

  it('symlink leaf and directory leaf fail closed without modifying the symlink target', async () => {
    // Break: following a symlink would clobber operator data outside the claim leaf contract.
    const api = requireApi();

    await withTempRoot('dir-leaf', async (root) => {
      await mkdir(claimAbs(root), { recursive: true });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, claimAbs(root)]),
        );
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            buildIdleObject(),
          ),
          (error) => assertUnavailable(error, [root, claimAbs(root)]),
        );
        await assert.rejects(
          () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, claimAbs(root)]),
        );
      });
      const st = await lstat(claimAbs(root));
      assert.equal(st.isDirectory(), true);
    });

    await withTempRoot('symlink-leaf', async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'linke-claim-sym-out-'));
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, CANONICAL_CLAIMED_BYTES, { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, claimAbs(root));
        const before = await readFile(target);

        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
            (error) => assertUnavailable(error, [
              root,
              claimAbs(root),
              target,
              outside,
              CLAIM_ID,
            ]),
          );
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryClaimState(
              resolvedRoot,
              lease,
              buildIdleObject(),
            ),
            (error) => assertUnavailable(error, [root, target, outside]),
          );
          await assert.rejects(
            () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease),
            (error) => assertUnavailable(error, [root, target, outside]),
          );
        });

        assert.deepEqual(await readFile(target), before);
        assert.equal(await readFile(target, 'utf8'), CANONICAL_CLAIMED_BYTES);
        const st = await lstat(claimAbs(root));
        assert.equal(st.isSymbolicLink(), true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('missing, forged, wrong-root, and expired leases fail closed before mutation', async () => {
    // Break: accepting a non-active lease would allow out-of-queue claim mutation.
    const api = requireApi();

    await withTempRoot('lease-missing-forged', async (root) => {
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      const forged = Object.freeze({});
      for (const lease of [null, undefined, forged, Object.freeze({ forged: true })]) {
        await assert.rejects(
          () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, 'forged']),
        );
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            buildIdleObject(),
          ),
          (error) => assertUnavailable(error, [root, 'forged']),
        );
        await assert.rejects(
          () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, 'forged']),
        );
      }
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('lease-wrong-root', async (rootA) => {
      await withTempRoot('lease-wrong-root-b', async (rootB) => {
        const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
        const resolvedB = await assertSafeDataRoot(rootB);
        await withLease(rootA, async (_resolvedA, lease) => {
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedB, lease),
            (error) => assertUnavailable(error, [rootA, rootB]),
          );
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryClaimState(
              resolvedB,
              lease,
              buildIdleObject(),
            ),
            (error) => assertUnavailable(error, [rootA, rootB]),
          );
          await assert.rejects(
            () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedB, lease),
            (error) => assertUnavailable(error, [rootA, rootB]),
          );
        });
        await assert.rejects(() => access(claimAbs(rootA)), { code: 'ENOENT' });
        await assert.rejects(() => access(claimAbs(rootB)), { code: 'ENOENT' });
      });
    });

    await withTempRoot('lease-expired', async (root) => {
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      let expiredLease = null;
      await withLease(root, async (_resolved, lease) => {
        expiredLease = lease;
      });
      assert.notEqual(expiredLease, null);
      await assert.rejects(
        () => api.loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, expiredLease),
        (error) => assertUnavailable(error, [root]),
      );
      await assert.rejects(
        () => api.publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          expiredLease,
          buildIdleObject(),
        ),
        (error) => assertUnavailable(error, [root]),
      );
      await assert.rejects(
        () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, expiredLease),
        (error) => assertUnavailable(error, [root]),
      );
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
    });
  });

  it('publish idle then claimed then idle round-trips exact raw bytes under one active lease', async () => {
    // Break: residual claimed bytes after release-to-idle would block successor claims incorrectly.
    const api = requireApi();
    await withTempRoot('roundtrip', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const idle1 = await api.publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          buildIdleObject(),
        );
        assertIdleShape(idle1);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_BYTES);

        await api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease);

        const claimed = await api.publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          buildClaimedObject(),
        );
        assertClaimedShape(claimed);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_CLAIMED_BYTES);

        await assert.rejects(
          () => api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, CLAIM_ID]),
        );

        const idle2 = await api.publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          buildIdleObject(),
        );
        assertIdleShape(idle2);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_BYTES);
        await api.assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease);

        const loaded = await api.loadAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
        );
        assertIdleShape(loaded);
        assert.deepEqual(loaded, idle2);
      });
    });
  });
});
