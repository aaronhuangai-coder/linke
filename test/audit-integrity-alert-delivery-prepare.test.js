/**
 * Audit integrity alert delivery prepare composer.
 * Production: src/audit-integrity-alert-delivery-prepare.js
 * Authority: docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-prepare-design.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAuditIntegrityAlertDeliveryRequest } from '../src/audit-integrity-alert-delivery.js';
import { AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH } from '../src/audit-integrity-alert-delivery-stream.js';
import { AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH } from '../src/audit-integrity-alert-outbox.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-prepare.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const MISSING_MSG = 'delivery prepare implementation missing';
const CANONICAL_ENDPOINT = 'https://alerts.example.invalid/hooks/audit-integrity';
const FIXED_CHECKED_AT = '2026-08-04T12:34:56.789Z';
const FIXED_STREAM_ID = 'a1111111-b111-4c11-8d11-e11111111111';
const STREAM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'status', 'sequence', 'streamId', 'request',
]);

/** @type {null | { prepareAuditIntegrityAlertDelivery: Function }} */
let prepareApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (typeof mod.prepareAuditIntegrityAlertDelivery === 'function') {
    prepareApi = { prepareAuditIntegrityAlertDelivery: mod.prepareAuditIntegrityAlertDelivery };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    prepareApi = null;
  } else {
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || prepareApi === null) assert.fail(MISSING_MSG);
  return prepareApi;
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-delivery-prepare-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertUnavailable(error, leakTokens = []) {
  assert.equal(/** @type {{ name?: string }} */ (error)?.name, 'LinkeError');
  assert.equal(/** @type {{ code?: string }} */ (error)?.code, 'audit-delivery-unavailable');
  assert.equal(/** @type {{ message?: string }} */ (error)?.message, 'audit-delivery-unavailable');
  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    ...Object.keys(/** @type {object} */ (error))
      .filter((k) => k !== 'stack')
      .map((k) => String(/** @type {Record<string, unknown>} */ (error)[k])),
  ].join('\0');
  for (const token of leakTokens) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `must not leak ${token}`);
  }
}

function assertDeeplyFrozen(value) {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(/** @type {Record<string, unknown>} */ (value))) {
    if (nested !== null && typeof nested === 'object') assertDeeplyFrozen(nested);
  }
}

function headEntry(sequence = 1) {
  return {
    sequence,
    checkedAt: FIXED_CHECKED_AT,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
  };
}

function outboxAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
}
function streamAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
}
function canonicalOutbox(nextSequence, entries) {
  return `${JSON.stringify({ schemaVersion: 1, nextSequence, entries })}\n`;
}
function canonicalStream(streamId) {
  return `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
}

async function writeOutbox(root, nextSequence, entries) {
  const abs = outboxAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalOutbox(nextSequence, entries);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

async function writeStream(root, streamId) {
  const abs = streamAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalStream(streamId);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

function assertEmptyReceipt(receipt) {
  assert.deepEqual(Object.keys(/** @type {object} */ (receipt)), [...RECEIPT_KEYS]);
  assert.deepEqual(receipt, {
    schemaVersion: 1, status: 'empty', sequence: null, streamId: null, request: null,
  });
  assertDeeplyFrozen(receipt);
}

describe('audit integrity alert delivery prepare', () => {
  it('1 empty outbox returns exact frozen empty receipt and creates no stream identity', async () => {
    const api = requireApi();
    await withTempRoot('empty', async (root) => {
      const receipt = await api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT);
      assertEmptyReceipt(receipt);
      await assert.rejects(access(streamAbs(root)), (e) => e.code === 'ENOENT');
      await assert.rejects(access(outboxAbs(root)), (e) => e.code === 'ENOENT');
    });
  });

  it('2 queued head creates/reuses stream identity and returns exact frozen prepared receipt/request', async () => {
    const api = requireApi();
    await withTempRoot('queued-create', async (root) => {
      const entry = headEntry(1);
      await writeOutbox(root, 2, [entry]);
      const receipt = await api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT);
      assert.deepEqual(Object.keys(/** @type {object} */ (receipt)), [...RECEIPT_KEYS]);
      assert.equal(/** @type {{ schemaVersion: unknown }} */ (receipt).schemaVersion, 1);
      assert.equal(/** @type {{ status: unknown }} */ (receipt).status, 'prepared');
      assert.equal(/** @type {{ sequence: unknown }} */ (receipt).sequence, 1);
      const streamId = /** @type {{ streamId: string }} */ (receipt).streamId;
      assert.match(streamId, STREAM_ID_RE);
      const expected = buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, streamId, entry);
      assert.deepEqual(/** @type {{ request: unknown }} */ (receipt).request, expected);
      assert.equal(
        /** @type {{ request: { headers: { 'idempotency-key': string } } }} */ (receipt)
          .request.headers['idempotency-key'],
        `audit-integrity-alert:${streamId}:1`,
      );
      assert.equal(
        JSON.parse(/** @type {{ request: { body: string } }} */ (receipt).request.body).streamId,
        streamId,
      );
      assertDeeplyFrozen(receipt);
      assert.equal(await readFile(streamAbs(root), 'utf8'), canonicalStream(streamId));
    });

    await withTempRoot('queued-reuse', async (root) => {
      const entry = headEntry(7);
      await writeOutbox(root, 8, [entry]);
      await writeStream(root, FIXED_STREAM_ID);
      const receipt = await api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT);
      assert.equal(/** @type {{ status: unknown }} */ (receipt).status, 'prepared');
      assert.equal(/** @type {{ sequence: unknown }} */ (receipt).sequence, 7);
      assert.equal(/** @type {{ streamId: unknown }} */ (receipt).streamId, FIXED_STREAM_ID);
      assert.deepEqual(
        /** @type {{ request: unknown }} */ (receipt).request,
        buildAuditIntegrityAlertDeliveryRequest(CANONICAL_ENDPOINT, FIXED_STREAM_ID, entry),
      );
      assertDeeplyFrozen(receipt);
    });
  });

  it('3 repeated prepare keeps identity/key stable and does not rewrite outbox bytes', async () => {
    const api = requireApi();
    await withTempRoot('stable', async (root) => {
      const outboxRaw = await writeOutbox(root, 4, [headEntry(3)]);
      const first = await api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT);
      const streamId = /** @type {{ streamId: string }} */ (first).streamId;
      const streamRaw = await readFile(streamAbs(root));
      const outboxBefore = await readFile(outboxAbs(root));
      const second = await api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT);
      assert.equal(/** @type {{ streamId: unknown }} */ (second).streamId, streamId);
      const key1 = /** @type {{ request: { headers: { 'idempotency-key': string } } }} */ (first)
        .request.headers['idempotency-key'];
      const key2 = /** @type {{ request: { headers: { 'idempotency-key': string } } }} */ (second)
        .request.headers['idempotency-key'];
      assert.equal(key1, key2);
      assert.equal(key2, `audit-integrity-alert:${streamId}:3`);
      assert.deepEqual(await readFile(outboxAbs(root)), outboxBefore);
      assert.equal(outboxBefore.toString('utf8'), outboxRaw);
      assert.deepEqual(await readFile(streamAbs(root)), streamRaw);
    });
  });

  it('4 invalid endpoint fails fixed audit-delivery-unavailable without rewriting outbox', async () => {
    const api = requireApi();
    await withTempRoot('bad-endpoint', async (root) => {
      const outboxRaw = await writeOutbox(root, 2, [headEntry(1)]);
      const bad = 'http://alerts.example.invalid/hooks/audit-integrity';
      await assert.rejects(
        api.prepareAuditIntegrityAlertDelivery(root, bad),
        (error) => {
          assertUnavailable(error, [bad, 'alerts.example.invalid', root]);
          return true;
        },
      );
      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxRaw);
      // ensure precedes request build; identity may already exist by call order.
      const streamRaw = await readFile(streamAbs(root), 'utf8');
      const streamId = JSON.parse(streamRaw).streamId;
      assert.match(streamId, STREAM_ID_RE);
      assert.equal(streamRaw, canonicalStream(streamId));
    });
  });

  it('5 corrupt outbox/stream state fails fixed and keeps exact bytes', async () => {
    const api = requireApi();
    await withTempRoot('corrupt-outbox', async (root) => {
      const abs = outboxAbs(root);
      await mkdir(dirname(abs), { recursive: true });
      const raw = '{"schemaVersion":1,"nextSequence":1,"entries":[BROKEN]}\n';
      await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(
        api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT),
        (error) => {
          assertUnavailable(error, [raw.slice(0, 40), abs, root, 'BROKEN']);
          return true;
        },
      );
      assert.equal(await readFile(abs, 'utf8'), raw);
      await assert.rejects(access(streamAbs(root)), (e) => e.code === 'ENOENT');
    });

    await withTempRoot('corrupt-stream', async (root) => {
      const outboxRaw = await writeOutbox(root, 2, [headEntry(1)]);
      const abs = streamAbs(root);
      await mkdir(dirname(abs), { recursive: true });
      const streamRaw = `${JSON.stringify({
        schemaVersion: 1, streamId: FIXED_STREAM_ID, extra: true,
      })}\n`;
      await writeFile(abs, streamRaw, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(
        api.prepareAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT),
        (error) => {
          assertUnavailable(error, [streamRaw.slice(0, 40), abs, root]);
          return true;
        },
      );
      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxRaw);
      assert.equal(await readFile(abs, 'utf8'), streamRaw);
    });
  });

  it('6 source import closed set: only read outbox + ensure stream + build request', async () => {
    if (implementationMissing) assert.fail(MISSING_MSG);
    const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');
    for (const needle of [
      "from './audit-integrity-alert-outbox.js'",
      "from './audit-integrity-alert-delivery-stream.js'",
      "from './audit-integrity-alert-delivery.js'",
      'readAuditIntegrityAlertOutbox',
      'ensureAuditIntegrityAlertDeliveryStream',
      'buildAuditIntegrityAlertDeliveryRequest',
      'prepareAuditIntegrityAlertDelivery',
    ]) {
      assert.equal(source.includes(needle), true, `expected surface: ${needle}`);
    }
    for (const forbidden of [
      'acknowledgeAuditIntegrityAlertOutboxHead',
      'enqueueAuditIntegrityAlertOutbox',
      'audit-integrity-monitor',
      'runAuditIntegrityMonitor',
      "from './agent.js'",
      "from './server.js'",
      'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:fs',
      'fs/promises', 'fetch(', 'setTimeout(', 'setInterval(', 'setImmediate(',
      'process.env', 'child_process', 'buildAuditIntegrityAlertDeliveryEnvelope',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden: ${forbidden}`);
    }
  });
});
