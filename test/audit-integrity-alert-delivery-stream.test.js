/**
 * Audit integrity alert delivery stream identity foundation.
 * Production: src/audit-integrity-alert-delivery-stream.js
 * Authority: docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-stream-design.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-stream.js',
  import.meta.url,
);
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const MISSING_MSG = 'delivery stream implementation missing';
const STREAM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_KEYS = Object.freeze(['schemaVersion', 'status', 'streamId']);
const FIXED_STREAM_ID = 'a1111111-b111-4c11-8d11-e11111111111';

/** @type {null | {
 *   AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH: string,
 *   ensureAuditIntegrityAlertDeliveryStream: (dataDir: unknown) => Promise<unknown>,
 * }} */
let streamApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.ensureAuditIntegrityAlertDeliveryStream === 'function'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH === 'string'
  ) {
    streamApi = {
      AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH:
        mod.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
      ensureAuditIntegrityAlertDeliveryStream:
        mod.ensureAuditIntegrityAlertDeliveryStream,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    streamApi = null;
  } else {
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || streamApi === null) {
    assert.fail(MISSING_MSG);
  }
  return streamApi;
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-delivery-stream-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(
    error && /** @type {{ code?: string }} */ (error).code,
    'audit-delivery-unavailable',
  );
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    'audit-delivery-unavailable',
  );
  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');
  for (const token of leakTokens) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `must not leak ${token}`);
  }
}

function canonicalState(streamId) {
  return `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
}

function streamAbs(root, relativePath) {
  return join(root, relativePath);
}

function assertReceipt(receipt, status, streamId) {
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(/** @type {object} */ (receipt)), [...RECEIPT_KEYS]);
  assert.equal(/** @type {{ schemaVersion: unknown }} */ (receipt).schemaVersion, 1);
  assert.equal(/** @type {{ status: unknown }} */ (receipt).status, status);
  assert.equal(/** @type {{ streamId: unknown }} */ (receipt).streamId, streamId);
  assert.match(streamId, STREAM_ID_RE);
}

describe('audit integrity alert delivery stream identity', () => {
  it('first ensure creates exact canonical UUIDv4 state mode0600 and deep-frozen created receipt', async () => {
    const api = requireApi();
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
      'audit/integrity-alert-delivery-stream.json',
    );
    await withTempRoot('create', async (root) => {
      const receipt = await api.ensureAuditIntegrityAlertDeliveryStream(root);
      const streamId = /** @type {{ streamId: string }} */ (receipt).streamId;
      assertReceipt(receipt, 'created', streamId);

      const abs = streamAbs(root, api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
      const raw = await readFile(abs, 'utf8');
      assert.equal(raw, canonicalState(streamId));
      assert.equal(Buffer.byteLength(raw, 'utf8') <= 128, true);
      const mode = (await lstat(abs)).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  });

  it('repeated ensure returns same ID as existing without rewriting original bytes', async () => {
    const api = requireApi();
    await withTempRoot('existing', async (root) => {
      const first = await api.ensureAuditIntegrityAlertDeliveryStream(root);
      const streamId = /** @type {{ streamId: string }} */ (first).streamId;
      assertReceipt(first, 'created', streamId);

      const abs = streamAbs(root, api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
      const before = await readFile(abs);
      const beforeStat = await lstat(abs);

      const second = await api.ensureAuditIntegrityAlertDeliveryStream(root);
      assertReceipt(second, 'existing', streamId);

      const after = await readFile(abs);
      assert.deepEqual(after, before);
      const afterStat = await lstat(abs);
      assert.equal(afterStat.ino, beforeStat.ino);
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
      assert.equal(afterStat.size, beforeStat.size);
    });
  });

  it('same-process concurrent ensures converge on one stream ID', async () => {
    const api = requireApi();
    await withTempRoot('concurrent', async (root) => {
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () => api.ensureAuditIntegrityAlertDeliveryStream(root)),
      );
      const ids = new Set(
        receipts.map((r) => /** @type {{ streamId: string }} */ (r).streamId),
      );
      assert.equal(ids.size, 1);
      const streamId = [...ids][0];
      assert.match(streamId, STREAM_ID_RE);

      const created = receipts.filter((r) => /** @type {{ status: string }} */ (r).status === 'created');
      const existing = receipts.filter((r) => /** @type {{ status: string }} */ (r).status === 'existing');
      assert.equal(created.length, 1);
      assert.equal(existing.length, 7);
      for (const receipt of receipts) {
        assertReceipt(receipt, /** @type {{ status: string }} */ (receipt).status, streamId);
      }

      const raw = await readFile(
        streamAbs(root, api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH),
        'utf8',
      );
      assert.equal(raw, canonicalState(streamId));
    });
  });

  it('independent child-process concurrent ensures converge on one stream ID', async () => {
    const api = requireApi();
    await withTempRoot('multiprocess', async (root) => {
      const script = [
        "import { ensureAuditIntegrityAlertDeliveryStream } from './src/audit-integrity-alert-delivery-stream.js';",
        'const receipt = await ensureAuditIntegrityAlertDeliveryStream(process.argv[1]);',
        'process.stdout.write(JSON.stringify(receipt));',
      ].join('\n');
      const results = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script, root],
        { cwd: REPO_ROOT, timeout: 15_000 },
      )));
      const receipts = results.map((r) => JSON.parse(r.stdout));
      const ids = new Set(receipts.map((r) => r.streamId));
      assert.equal(ids.size, 1);
      const streamId = [...ids][0];
      assert.match(streamId, STREAM_ID_RE);
      assert.equal(
        receipts.filter((r) => r.status === 'created').length,
        1,
      );
      assert.equal(
        receipts.filter((r) => r.status === 'existing').length,
        3,
      );
      const raw = await readFile(
        streamAbs(root, api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH),
        'utf8',
      );
      assert.equal(raw, canonicalState(streamId));
    });
  });

  it('corrupt/extra/unordered/noncanonical/invalid UUID state fails fixed and keeps bytes', async () => {
    const api = requireApi();
    const variants = [
      '{"schemaVersion":1,"streamId":BROKEN}\n',
      `${JSON.stringify({ schemaVersion: 1, streamId: FIXED_STREAM_ID, extra: true })}\n`,
      `${JSON.stringify({ streamId: FIXED_STREAM_ID, schemaVersion: 1 })}\n`,
      `${JSON.stringify({ schemaVersion: 1, streamId: FIXED_STREAM_ID }, null, 2)}\n`,
      `${JSON.stringify({ schemaVersion: 1, streamId: FIXED_STREAM_ID })}`,
      `${JSON.stringify({ schemaVersion: 1, streamId: FIXED_STREAM_ID.toUpperCase() })}\n`,
      `${JSON.stringify({ schemaVersion: 1, streamId: '11111111-1111-1111-8111-111111111111' })}\n`,
      `${JSON.stringify({ schemaVersion: 2, streamId: FIXED_STREAM_ID })}\n`,
    ];
    for (const [index, raw] of variants.entries()) {
      await withTempRoot(`invalid-${index}`, async (root) => {
        const abs = streamAbs(
          root,
          api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
        );
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
        await assert.rejects(
          api.ensureAuditIntegrityAlertDeliveryStream(root),
          (error) => {
            assertUnavailable(error, [raw.slice(0, 40), abs, root, 'BROKEN']);
            return true;
          },
        );
        assert.equal(await readFile(abs, 'utf8'), raw);
      });
    }
  });

  it('oversized and symlink leaf fail fixed without modifying target', async () => {
    const api = requireApi();
    await withTempRoot('oversize', async (root) => {
      const abs = streamAbs(
        root,
        api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
      );
      const raw = `{"padding":"${'x'.repeat(200)}"}\n`;
      assert.equal(Buffer.byteLength(raw, 'utf8') > 128, true);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(
        api.ensureAuditIntegrityAlertDeliveryStream(root),
        (error) => {
          assertUnavailable(error, [abs, root, 'padding']);
          return true;
        },
      );
      assert.equal((await readFile(abs)).length, Buffer.byteLength(raw));
    });

    await withTempRoot('symlink', async (root) => {
      const target = join(root, 'target.json');
      const raw = canonicalState(FIXED_STREAM_ID);
      await writeFile(target, raw, { encoding: 'utf8', mode: 0o600 });
      const abs = streamAbs(
        root,
        api.AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
      );
      await mkdir(dirname(abs), { recursive: true });
      await symlink(target, abs);
      await assert.rejects(
        api.ensureAuditIntegrityAlertDeliveryStream(root),
        (error) => {
          assertUnavailable(error, [abs, target, root, FIXED_STREAM_ID]);
          return true;
        },
      );
      assert.equal(await readFile(target, 'utf8'), raw);
    });
  });

  it('missing or file data root fails fixed without creating or modifying path', async () => {
    const api = requireApi();
    await withTempRoot('missing-root', async (parent) => {
      const absentRoot = join(parent, 'must-remain-absent');
      await assert.rejects(
        api.ensureAuditIntegrityAlertDeliveryStream(absentRoot),
        (error) => {
          assertUnavailable(error, [absentRoot, parent]);
          return true;
        },
      );
      await assert.rejects(access(absentRoot), (error) => error.code === 'ENOENT');
    });

    await withTempRoot('file-root', async (parent) => {
      const fileRoot = join(parent, 'not-a-dir');
      await writeFile(fileRoot, 'not-a-directory\n', { encoding: 'utf8', mode: 0o600 });
      const before = await readFile(fileRoot);
      await assert.rejects(
        api.ensureAuditIntegrityAlertDeliveryStream(fileRoot),
        (error) => {
          assertUnavailable(error, [fileRoot, parent]);
          return true;
        },
      );
      assert.deepEqual(await readFile(fileRoot), before);
    });
  });

  it('source allows only crypto/error-codes/safe-data-files/write-queue and forbids delivery/outbox/monitor/agent surfaces', async () => {
    requireApi();
    const source = await readFile(PRODUCTION_MODULE_URL, 'utf8');
    const allowedImportNeedles = [
      "from 'node:crypto'",
      "from './error-codes.js'",
      "from './safe-data-files.js'",
      "from './audit-integrity-write-queue.js'",
    ];
    for (const needle of allowedImportNeedles) {
      assert.equal(source.includes(needle), true, `expected import surface: ${needle}`);
    }

    for (const forbidden of [
      'audit-integrity-alert-delivery.js',
      'buildAuditIntegrityAlertDeliveryEnvelope',
      'buildAuditIntegrityAlertDeliveryRequest',
      'audit-integrity-alert-outbox',
      'enqueueAuditIntegrityAlertOutbox',
      'readAuditIntegrityAlertOutbox',
      'acknowledgeAuditIntegrityAlertOutboxHead',
      'audit-integrity-monitor',
      'runAuditIntegrityMonitor',
      "from './agent.js'",
      "from './server.js'",
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'fetch(',
      'setInterval(',
      'setTimeout(',
      'setImmediate(',
      'process.env',
      'process.argv',
      'child_process',
      'Keychain',
      'launchctl',
      'acquireAuditIntegrityProcessLock',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden source surface: ${forbidden}`);
    }
    assert.equal(/keychain/i.test(source), false);
    assert.equal(/credential/i.test(source), false);
  });
});
