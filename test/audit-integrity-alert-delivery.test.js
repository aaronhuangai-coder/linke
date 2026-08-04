/**
 * RED — audit integrity alert delivery envelope (pure request foundation).
 *
 * Production module: src/audit-integrity-alert-delivery.js (intentionally absent at RED).
 * Dynamic import captures MODULE_NOT_FOUND so this file does not crash at load time;
 * each behavior test fails with the exact message:
 *   delivery envelope implementation missing
 *
 * Authority: docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-envelope-design.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

const FIXED_CHECKED_AT = '2026-08-04T12:34:56.789Z';
const CANONICAL_ENDPOINT = 'https://alerts.example.invalid/hooks/audit-integrity';
const STREAM_ID = 'a1111111-b111-4c11-8d11-e11111111111';
const OTHER_STREAM_ID = 'b2222222-c222-4d22-9e22-f22222222222';
const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const MISSING_MSG = 'delivery envelope implementation missing';

const ENTRY_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);

const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'streamId',
  'idempotencyKey',
  'deliverySemantics',
  'alert',
]);

const REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'url',
  'method',
  'headers',
  'body',
]);

const HEADER_KEYS = Object.freeze(['content-type', 'idempotency-key']);

/** @type {null | {
 *   buildAuditIntegrityAlertDeliveryEnvelope: (entry: unknown) => unknown,
 *   buildAuditIntegrityAlertDeliveryRequest: (endpoint: unknown, entry: unknown) => unknown,
 *   buildEnvelopeForStream: (streamId: unknown, entry: unknown) => unknown,
 *   buildRequestForStream: (endpoint: unknown, streamId: unknown, entry: unknown) => unknown,
 * }} */
let deliveryApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  const buildEnvelope = mod.buildAuditIntegrityAlertDeliveryEnvelope;
  const buildRequest = mod.buildAuditIntegrityAlertDeliveryRequest;
  if (typeof buildEnvelope === 'function' && typeof buildRequest === 'function') {
    deliveryApi = {
      buildAuditIntegrityAlertDeliveryEnvelope: (entry) => buildEnvelope(STREAM_ID, entry),
      buildAuditIntegrityAlertDeliveryRequest: (endpoint, entry) => (
        buildRequest(endpoint, STREAM_ID, entry)
      ),
      buildEnvelopeForStream: buildEnvelope,
      buildRequestForStream: buildRequest,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object' ? /** @type {{ code?: string }} */ (error).code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    deliveryApi = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireDeliveryApi() {
  if (implementationMissing || deliveryApi === null) {
    assert.fail(MISSING_MSG);
  }
  return deliveryApi;
}

/**
 * @param {Partial<{
 *   sequence: number,
 *   checkedAt: string,
 *   code: string,
 *   recoveryRequired: boolean,
 *   nextAction: string,
 *   reasonCode: string | null,
 * }>} [overrides]
 */
function validEntry(overrides = {}) {
  return {
    sequence: 1,
    checkedAt: FIXED_CHECKED_AT,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
    ...overrides,
  };
}

/**
 * Rebuild entry with exact outbox key order (spread can reorder).
 * @param {ReturnType<typeof validEntry>} entry
 */
function withExactEntryKeyOrder(entry) {
  return {
    sequence: entry.sequence,
    checkedAt: entry.checkedAt,
    code: entry.code,
    recoveryRequired: entry.recoveryRequired,
    nextAction: entry.nextAction,
    reasonCode: entry.reasonCode,
  };
}

/** Allowed outbox code/semantic matrix (design / outbox contract). */
const ALLOWED_ENTRIES = Object.freeze([
  withExactEntryKeyOrder(validEntry({
    sequence: 1,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 2,
    code: 'state-missing',
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: null,
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 3,
    code: 'recovery-required',
    recoveryRequired: true,
    nextAction: 'run-explicit-recovery',
    reasonCode: null,
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 4,
    code: 'rotation-recovery-required',
    recoveryRequired: true,
    nextAction: 'run-explicit-recovery',
    reasonCode: 'audit-integrity-rotation-recovery-required',
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 5,
    code: 'integrity-alert',
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: null,
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 6,
    code: 'integrity-alert',
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: 'cross-store-broken',
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 7,
    code: 'io-alert',
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: null,
  })),
  withExactEntryKeyOrder(validEntry({
    sequence: 8,
    code: 'io-alert',
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: 'dual-write-io-error',
  })),
]);

/**
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(error && /** @type {{ code?: string }} */ (error).code, 'audit-delivery-unavailable');
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    'audit-delivery-unavailable',
  );

  // Public surface only — do not scan stack (may contain workspace paths).
  const ownPublic = Object.keys(/** @type {object} */ (error))
    .filter((key) => key !== 'stack')
    .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key]));
  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    String(/** @type {{ statusCode?: unknown }} */ (error).statusCode),
    String(/** @type {{ retryable?: unknown }} */ (error).retryable),
    ...ownPublic,
  ].join('\0');

  for (const token of leakTokens) {
    if (!token || token.length < 2) continue;
    assert.equal(
      publicParts.includes(token),
      false,
      `public error must not leak ${token}`,
    );
  }
}

/**
 * @param {() => unknown} fn
 * @param {string[]} [leakTokens]
 */
function expectUnavailable(fn, leakTokens = []) {
  assert.throws(fn, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * @param {unknown} value
 * @returns {asserts value is object}
 */
function assertDeeplyFrozen(value) {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Object.isFrozen(value), true);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') assertDeeplyFrozen(item);
    }
    return;
  }
  for (const nested of Object.values(/** @type {Record<string, unknown>} */ (value))) {
    if (nested !== null && typeof nested === 'object') assertDeeplyFrozen(nested);
  }
}

describe('audit integrity alert delivery envelope', () => {
  it('builds exact-key deep-frozen defensive-copy envelope with fixed schema/kind/idempotency/semantics', () => {
    const api = requireDeliveryApi();
    const entry = withExactEntryKeyOrder(validEntry({ sequence: 11 }));
    const envelope = api.buildAuditIntegrityAlertDeliveryEnvelope(entry);

    assert.deepEqual(Object.keys(/** @type {object} */ (envelope)), [...ENVELOPE_KEYS]);
    assert.equal(/** @type {{ schemaVersion: unknown }} */ (envelope).schemaVersion, 1);
    assert.equal(/** @type {{ kind: unknown }} */ (envelope).kind, 'audit-integrity-alert');
    assert.equal(/** @type {{ streamId: unknown }} */ (envelope).streamId, STREAM_ID);
    assert.equal(
      /** @type {{ idempotencyKey: unknown }} */ (envelope).idempotencyKey,
      `audit-integrity-alert:${STREAM_ID}:11`,
    );
    assert.equal(
      /** @type {{ deliverySemantics: unknown }} */ (envelope).deliverySemantics,
      'at-least-once',
    );

    const alert = /** @type {{ alert: object }} */ (envelope).alert;
    assert.deepEqual(Object.keys(alert), [...ENTRY_KEYS]);
    assert.deepEqual(alert, entry);
    assert.notEqual(alert, entry);

    assertDeeplyFrozen(envelope);

    // Defensive copy: mutating the input after build must not change the envelope.
    entry.sequence = 999;
    entry.checkedAt = 'mutated';
    entry.code = 'mutated';
    assert.equal(/** @type {{ sequence: unknown }} */ (alert).sequence, 11);
    assert.equal(/** @type {{ checkedAt: unknown }} */ (alert).checkedAt, FIXED_CHECKED_AT);
    assert.equal(/** @type {{ code: unknown }} */ (alert).code, 'uninitialized');
    assert.equal(
      /** @type {{ idempotencyKey: unknown }} */ (envelope).idempotencyKey,
      `audit-integrity-alert:${STREAM_ID}:11`,
    );
  });

  it('builds exact POST request descriptor with fixed headers and compact envelope JSON body', () => {
    const api = requireDeliveryApi();
    const entry = withExactEntryKeyOrder(validEntry({ sequence: 3 }));
    const request = api.buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, entry);

    assert.deepEqual(Object.keys(/** @type {object} */ (request)), [...REQUEST_KEYS]);
    assert.equal(/** @type {{ schemaVersion: unknown }} */ (request).schemaVersion, 1);
    assert.equal(/** @type {{ url: unknown }} */ (request).url, CANONICAL_ENDPOINT);
    assert.equal(/** @type {{ method: unknown }} */ (request).method, 'POST');

    const headers = /** @type {{ headers: object }} */ (request).headers;
    assert.deepEqual(Object.keys(headers), [...HEADER_KEYS]);
    assert.equal(
      /** @type {{ 'content-type': unknown }} */ (headers)['content-type'],
      'application/json',
    );
    assert.equal(
      /** @type {{ 'idempotency-key': unknown }} */ (headers)['idempotency-key'],
      `audit-integrity-alert:${STREAM_ID}:3`,
    );

    const expectedBody = JSON.stringify({
      schemaVersion: 1,
      kind: 'audit-integrity-alert',
      streamId: STREAM_ID,
      idempotencyKey: `audit-integrity-alert:${STREAM_ID}:3`,
      deliverySemantics: 'at-least-once',
      alert: entry,
    });
    assert.equal(/** @type {{ body: unknown }} */ (request).body, expectedBody);
    assert.equal(expectedBody.includes(' '), false);
    assert.equal(expectedBody.includes('\n'), false);

    assertDeeplyFrozen(request);

    // Descriptor is pure composition — not a live Response / stream / fetch handle.
    assert.equal(typeof /** @type {{ body: unknown }} */ (request).body, 'string');
  });

  it('produces stable and distinct idempotency keys across streams and sequences', () => {
    const api = requireDeliveryApi();
    const entryA = withExactEntryKeyOrder(validEntry({ sequence: 1 }));
    const entryB = withExactEntryKeyOrder(validEntry({ sequence: 2 }));
    const entryAAgain = withExactEntryKeyOrder(validEntry({ sequence: 1 }));

    const envA1 = api.buildAuditIntegrityAlertDeliveryEnvelope(entryA);
    const envB = api.buildAuditIntegrityAlertDeliveryEnvelope(entryB);
    const envA2 = api.buildAuditIntegrityAlertDeliveryEnvelope(entryAAgain);
    const envOtherStream = api.buildEnvelopeForStream(OTHER_STREAM_ID, entryA);
    const reqA = api.buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, entryA);
    const reqB = api.buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, entryB);

    assert.equal(
      /** @type {{ idempotencyKey: unknown }} */ (envA1).idempotencyKey,
      `audit-integrity-alert:${STREAM_ID}:1`,
    );
    assert.equal(
      /** @type {{ idempotencyKey: unknown }} */ (envB).idempotencyKey,
      `audit-integrity-alert:${STREAM_ID}:2`,
    );
    assert.equal(
      /** @type {{ idempotencyKey: unknown }} */ (envA1).idempotencyKey,
      /** @type {{ idempotencyKey: unknown }} */ (envA2).idempotencyKey,
    );
    assert.notEqual(
      /** @type {{ idempotencyKey: unknown }} */ (envA1).idempotencyKey,
      /** @type {{ idempotencyKey: unknown }} */ (envB).idempotencyKey,
    );
    assert.notEqual(
      /** @type {{ idempotencyKey: unknown }} */ (envA1).idempotencyKey,
      /** @type {{ idempotencyKey: unknown }} */ (envOtherStream).idempotencyKey,
    );
    assert.equal(
      /** @type {{ headers: { 'idempotency-key': unknown } }} */ (reqA).headers['idempotency-key'],
      `audit-integrity-alert:${STREAM_ID}:1`,
    );
    assert.equal(
      /** @type {{ headers: { 'idempotency-key': unknown } }} */ (reqB).headers['idempotency-key'],
      `audit-integrity-alert:${STREAM_ID}:2`,
    );
  });

  it('accepts every outbox-allowed code/semantic combo and rejects mismatches, extra/unordered keys, noncanonical time, illegal reason', () => {
    const api = requireDeliveryApi();

    for (const entry of ALLOWED_ENTRIES) {
      const envelope = api.buildAuditIntegrityAlertDeliveryEnvelope(entry);
      assert.equal(
        /** @type {{ alert: { code: unknown } }} */ (envelope).alert.code,
        entry.code,
      );
      assert.equal(
        /** @type {{ alert: { reasonCode: unknown } }} */ (envelope).alert.reasonCode,
        entry.reasonCode,
      );
      const request = api.buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, entry);
      assert.equal(/** @type {{ method: unknown }} */ (request).method, 'POST');
    }

    const semanticMismatches = [
      withExactEntryKeyOrder(validEntry({ recoveryRequired: true })),
      withExactEntryKeyOrder(validEntry({
        code: 'integrity-alert',
        recoveryRequired: false,
        nextAction: 'run-explicit-recovery',
        reasonCode: null,
      })),
      withExactEntryKeyOrder(validEntry({
        code: 'io-alert',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: 'not-an-io-failure',
      })),
      withExactEntryKeyOrder(validEntry({
        code: 'rotation-recovery-required',
        recoveryRequired: true,
        nextAction: 'run-explicit-recovery',
        reasonCode: null,
      })),
      withExactEntryKeyOrder(validEntry({
        code: 'unknown-code',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: null,
      })),
    ];
    for (const entry of semanticMismatches) {
      expectUnavailable(() => api.buildAuditIntegrityAlertDeliveryEnvelope(entry));
      expectUnavailable(
        () => api.buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, entry),
      );
    }

    const withExtra = {
      ...withExactEntryKeyOrder(validEntry()),
      extra: true,
    };
    expectUnavailable(() => api.buildAuditIntegrityAlertDeliveryEnvelope(withExtra));

    const unordered = {
      checkedAt: FIXED_CHECKED_AT,
      sequence: 1,
      code: 'uninitialized',
      recoveryRequired: false,
      nextAction: 'initialize-via-production-write',
      reasonCode: null,
    };
    assert.notDeepEqual(Object.keys(unordered), [...ENTRY_KEYS]);
    expectUnavailable(() => api.buildAuditIntegrityAlertDeliveryEnvelope(unordered));

    const nonCanonicalTimes = [
      '2026-08-04T12:34:56Z',
      '2026-08-04T12:34:56.789+00:00',
      '2026-08-04 12:34:56.789Z',
      '2026-02-30T00:00:00.000Z',
      '2026-08-04T12:34:56.789',
    ];
    for (const checkedAt of nonCanonicalTimes) {
      expectUnavailable(() => api.buildAuditIntegrityAlertDeliveryEnvelope(
        withExactEntryKeyOrder(validEntry({ checkedAt })),
      ));
    }

    const illegalReasons = [
      withExactEntryKeyOrder(validEntry({
        code: 'integrity-alert',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: 'HasUpper',
      })),
      withExactEntryKeyOrder(validEntry({
        code: 'integrity-alert',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: '/tmp/secret-path',
      })),
      withExactEntryKeyOrder(validEntry({
        code: 'integrity-alert',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: 'has space',
      })),
      withExactEntryKeyOrder(validEntry({
        code: 'io-alert',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: 'disk-full',
      })),
    ];
    for (const entry of illegalReasons) {
      const leak = typeof entry.reasonCode === 'string' ? [entry.reasonCode] : [];
      expectUnavailable(() => api.buildAuditIntegrityAlertDeliveryEnvelope(entry), leak);
    }
  });

  it('rejects non-HTTPS, credentials, query, fragment, non-canonical URL, empty, and oversize endpoints', () => {
    const api = requireDeliveryApi();
    const entry = withExactEntryKeyOrder(validEntry({ sequence: 1 }));
    const commonLeak = [
      'alerts.example.invalid',
      'user:pass',
      's3cret',
      '?x=1',
      '#frag',
    ];

    const rejectedEndpoints = [
      'http://alerts.example.invalid/hooks/audit-integrity',
      'https://user:pass@alerts.example.invalid/hooks/audit-integrity',
      'https://alerts.example.invalid/hooks/audit-integrity?x=1',
      'https://alerts.example.invalid/hooks/audit-integrity#frag',
      'HTTPS://alerts.example.invalid/hooks/audit-integrity',
      'https://alerts.example.invalid:443/hooks/audit-integrity',
      'https://Alerts.Example.Invalid/hooks/audit-integrity',
      '',
      '   ',
      null,
      undefined,
      0,
      false,
      {},
    ];

    for (const endpoint of rejectedEndpoints) {
      const leakTokens = typeof endpoint === 'string' && endpoint.length >= 2
        ? [endpoint, ...commonLeak]
        : commonLeak;
      expectUnavailable(
        () => api.buildAuditIntegrityAlertDeliveryRequest(endpoint, entry),
        leakTokens,
      );
    }

    // Over 2048 UTF-8 bytes (canonical-looking HTTPS path padding).
    const prefix = 'https://alerts.example.invalid/hooks/';
    const oversize = `${prefix}${'a'.repeat(2048 - Buffer.byteLength(prefix, 'utf8') + 1)}`;
    assert.equal(Buffer.byteLength(oversize, 'utf8'), 2049);
    expectUnavailable(
      () => api.buildAuditIntegrityAlertDeliveryRequest(oversize, entry),
      [oversize.slice(0, 80), 'alerts.example.invalid'],
    );

    // Boundary: exactly 2048 UTF-8 bytes of an otherwise canonical HTTPS URL is accepted.
    const exact = `${prefix}${'b'.repeat(2048 - Buffer.byteLength(prefix, 'utf8'))}`;
    assert.equal(Buffer.byteLength(exact, 'utf8'), 2048);
    assert.equal(exact, new URL(exact).href);
    const ok = api.buildAuditIntegrityAlertDeliveryRequest(exact, entry);
    assert.equal(/** @type {{ url: unknown }} */ (ok).url, exact);
  });

  it('maps every illegal input to exact path-free LinkeError audit-delivery-unavailable without leaking endpoint/path/raw error', () => {
    const api = requireDeliveryApi();
    const secretEndpoint = 'https://user:s3cret@evil.example.invalid/path/to/hook?token=raw-error#leak';
    const secretPathReason = '/Users/ah/secret/audit.log';

    const hostileEntry = new Proxy(Object.freeze(Object.create(null)), {
      get() {
        throw new Error(`hostile get ${secretPathReason} raw-error-xyz`);
      },
      ownKeys() {
        throw new Error('hostile ownKeys raw-error-xyz');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor raw-error-xyz');
      },
      getPrototypeOf() {
        throw new Error('hostile prototype raw-error-xyz');
      },
    });

    const hostileEndpoint = new Proxy(Object.freeze(Object.create(null)), {
      get() {
        throw new Error(`hostile endpoint ${secretEndpoint}`);
      },
      ownKeys() {
        throw new Error('hostile endpoint ownKeys');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile endpoint descriptor');
      },
    });

    const cases = [
      {
        run: () => api.buildEnvelopeForStream('', withExactEntryKeyOrder(validEntry())),
        leak: [],
      },
      {
        run: () => api.buildEnvelopeForStream(
          STREAM_ID.toUpperCase(),
          withExactEntryKeyOrder(validEntry()),
        ),
        leak: [STREAM_ID.toUpperCase()],
      },
      {
        run: () => api.buildRequestForStream(
          CANONICAL_ENDPOINT,
          '11111111-1111-1111-8111-111111111111',
          withExactEntryKeyOrder(validEntry()),
        ),
        leak: ['11111111-1111-1111-8111-111111111111'],
      },
      {
        run: () => api.buildAuditIntegrityAlertDeliveryEnvelope(null),
        leak: [],
      },
      {
        run: () => api.buildAuditIntegrityAlertDeliveryEnvelope(hostileEntry),
        leak: [secretPathReason, 'raw-error-xyz', 'hostile'],
      },
      {
        run: () => api.buildAuditIntegrityAlertDeliveryEnvelope(
          withExactEntryKeyOrder(validEntry({ sequence: 0 })),
        ),
        leak: [],
      },
      {
        run: () => api.buildAuditIntegrityAlertDeliveryRequest(
          secretEndpoint,
          withExactEntryKeyOrder(validEntry()),
        ),
        leak: [
          secretEndpoint,
          's3cret',
          'evil.example.invalid',
          'token=raw-error',
          '/path/to/hook',
        ],
      },
      {
        run: () => api.buildAuditIntegrityAlertDeliveryRequest(
          hostileEndpoint,
          withExactEntryKeyOrder(validEntry()),
        ),
        leak: [secretEndpoint, 's3cret', 'hostile', 'raw-error'],
      },
      {
        run: () => api.buildAuditIntegrityAlertDeliveryEnvelope(
          withExactEntryKeyOrder(validEntry({
            code: 'integrity-alert',
            recoveryRequired: false,
            nextAction: 'investigate-integrity',
            reasonCode: secretPathReason,
          })),
        ),
        leak: [secretPathReason, '/Users/'],
      },
    ];

    for (const testCase of cases) {
      expectUnavailable(testCase.run, testCase.leak);
    }
  });

  it('production module forbids fetch/http/https/net/tls/dns/child_process/fs/timer/env/outbox read-ack surfaces', async () => {
    if (implementationMissing) {
      assert.fail(MISSING_MSG);
    }

    let source;
    try {
      source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');
    } catch {
      assert.fail(MISSING_MSG);
    }

    const forbidden = [
      'fetch(',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:child_process',
      'child_process',
      'node:fs',
      'fs/promises',
      'setTimeout(',
      'setInterval(',
      'setImmediate(',
      'process.env',
      'readAuditIntegrityAlertOutbox',
      'acknowledgeAuditIntegrityAlertOutboxHead',
      'enqueueAuditIntegrityAlertOutbox',
    ];
    for (const needle of forbidden) {
      assert.equal(
        source.includes(needle),
        false,
        `forbidden production surface: ${needle}`,
      );
    }

    // Positive anchors: pure builders only.
    assert.equal(source.includes('buildAuditIntegrityAlertDeliveryEnvelope'), true);
    assert.equal(source.includes('buildAuditIntegrityAlertDeliveryRequest'), true);
  });
});
