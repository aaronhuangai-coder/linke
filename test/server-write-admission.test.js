/**
 * V1.39 C1: server required write-admission fail-closed.
 *
 * Proves central gate after auth/rate, exact-one api.write.admission.started,
 * 503 remap on unrecoverable/invalid/append failure, recoverable prepared
 * auto-recover + mutation proceeds, and best-effort denial/read paths stay out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_WRITE_ROUTES,
  createServer,
  isApiWriteRoute,
} from '../src/server.js';
import { readAuditEvents } from '../src/audit-log.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';

const ADMISSION_TYPE = 'api.write.admission.started';
const FORBIDDEN_ADMISSION_KEYS = [
  'body',
  'token',
  'Authorization',
  'sourcePath',
  'targetPath',
  'deviceId',
  'snapshotId',
  'secret',
];

const FROZEN_WRITE_ROUTES = Object.freeze([
  { method: 'POST', path: '/api/heartbeat' },
  { method: 'POST', path: '/api/backups' },
  { method: 'POST', path: '/api/restore' },
  { method: 'POST', path: '/api/supervisor-lifecycle-approval-persist' },
  { method: 'POST', path: '/api/device-enrollment-codes' },
  { method: 'POST', path: '/api/device-revoke' },
]);

const SEED_EVENT = Object.freeze({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: '2026-07-20T00:00:00.000Z',
  type: 'api.seed',
  method: 'POST',
  path: '/api/seed',
  outcome: 'success',
});
function stateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

async function withTempRoot(prefix, fn) {
  const { mkdtemp } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), `linke-swa-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withServer(options, fn) {
  return withTempRoot('srv', async (dataDir) => {
    const server = createServer({ dataDir, ...options });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      return await fn({ port, dataDir, server });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

function authHeaders(token, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function postJson(port, path, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function baseDeviceAdmin(spies) {
  return {
    issueEnrollment: async ({ deviceId }) => {
      spies.issueEnrollment += 1;
      return {
        deviceId,
        code: 'one-time-code-xyz',
        expiresAt: '2026-07-20T00:10:00.000Z',
      };
    },
    revokeDevice: async () => {
      spies.revokeDevice += 1;
      return { deviceId: 'mac-alpha', revoked: true };
    },
    getStatus: async () => ({ active: 0, revoked: 0 }),
    agentUrl: 'https://linke-controller.local:3443',
    tlsFingerprint: 'a'.repeat(64),
  };
}

/** Deterministic validation bodies: admission must run, then original 4xx semantics. */
function validationBodyFor(path) {
  switch (path) {
    case '/api/heartbeat':
      return {}; // missing deviceId → 400 deviceId is required
    case '/api/backups':
      return { deviceId: 'mac-alpha' }; // missing sourcePath → 400
    case '/api/restore':
      return { deviceId: 'mac-alpha' }; // missing snapshotId/targetPath → 400
    case '/api/supervisor-lifecycle-approval-persist':
      return { operation: 'not-a-real-op' }; // invalid operation → 400
    case '/api/device-enrollment-codes':
      return { deviceId: 'Bad_ID' }; // invalid grammar → 400 device-request-invalid
    case '/api/device-revoke':
      return { deviceId: 'Bad_ID' };
    default:
      throw new Error(`unknown write path ${path}`);
  }
}

function expectedValidationStatus(path) {
  if (path === '/api/device-enrollment-codes' || path === '/api/device-revoke') {
    return { status: 400, error: ERROR_CODES.DEVICE_REQUEST_INVALID };
  }
  if (path === '/api/heartbeat') {
    return { status: 400, error: 'deviceId is required' };
  }
  if (path === '/api/backups') {
    return { status: 400, error: 'deviceId and sourcePath are required' };
  }
  if (path === '/api/restore') {
    return { status: 400, error: 'deviceId, snapshotId, and targetPath are required' };
  }
  if (path === '/api/supervisor-lifecycle-approval-persist') {
    return {
      status: 400,
      error: 'operation must be one of: install, uninstall, rollback, recover',
    };
  }
  throw new Error(`unknown write path ${path}`);
}

/** Bodies that would reach mutation if admission passed (for fail-closed zero-side-effect). */
function mutationBodyFor(path) {
  switch (path) {
    case '/api/heartbeat':
      return { deviceId: 'mac-admit-hb', hostname: 'host', ipAddress: '10.0.0.1' };
    case '/api/backups':
      return {
        deviceId: 'mac-admit-bk',
        sourcePath: '/tmp/linke-should-not-be-read-by-fail-closed',
      };
    case '/api/restore':
      return {
        deviceId: 'mac-admit-rs',
        snapshotId: '11111111-1111-4111-8111-111111111111',
        targetPath: '/tmp/linke-should-not-restore-target',
      };
    case '/api/supervisor-lifecycle-approval-persist':
      return {
        operation: 'install',
        config: { deviceId: 'mac-x', sourcePath: '/tmp/x' },
        approval: { not: 'enough' },
      };
    case '/api/device-enrollment-codes':
      return { deviceId: 'mac-alpha' };
    case '/api/device-revoke':
      return { deviceId: 'mac-alpha' };
    default:
      throw new Error(`unknown write path ${path}`);
  }
}

function assertNoLeakage(text, dataDir, token) {
  assert.ok(!text.includes(dataDir), 'response must not leak dataDir');
  assert.ok(!text.includes('integrity-dual-write-state'), 'response must not leak state path');
  assert.ok(!text.includes('events.jsonl'), 'response must not leak events path');
  assert.ok(!text.includes('integrity-journal'), 'response must not leak journal path');
  if (token) assert.ok(!text.includes(token), 'response must not leak token');
  assert.ok(!/ENOENT|EACCES|stack|at\s+\S+\s+\(/i.test(text), 'response must not leak stack/errno-ish');
  assert.ok(!text.includes('occupied-invalid-state'), 'response must not leak state body');
}

function assertAdmissionShape(event, route) {
  assert.equal(event.type, ADMISSION_TYPE);
  assert.equal(event.method, route.method);
  assert.equal(event.path, route.path);
  assert.equal(event.outcome, 'started');
  assert.equal(typeof event.requestId, 'string');
  assert.ok(event.requestId.length > 0);
  assert.equal(typeof event.id, 'string');
  assert.equal(typeof event.createdAt, 'string');
  for (const key of FORBIDDEN_ADMISSION_KEYS) {
    assert.ok(!(key in event), `admission event must not contain ${key}`);
  }
}

async function listAdmissionEvents(dataDir) {
  const events = await readAuditEvents(dataDir, { limit: 100 });
  return events.filter((e) => e && e.type === ADMISSION_TYPE);
}

async function snapshotBusinessBytes(dataDir) {
  const paths = [];
  async function walk(rel) {
    const abs = join(dataDir, rel);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = join(rel, entry.name);
      if (entry.isDirectory()) {
        // Skip audit dual-write/events/journal — admission failure may leave them unchanged
        // but recovery/append paths intentionally change them.
        if (childRel === 'audit') continue;
        await walk(childRel);
      } else if (entry.isFile()) {
        paths.push(childRel);
      }
    }
  }
  await walk('');
  const map = new Map();
  for (const rel of paths.sort()) {
    map.set(rel, await readFile(join(dataDir, rel)));
  }
  return map;
}

function assertBusinessUnchanged(before, after) {
  assert.deepEqual([...after.keys()], [...before.keys()], 'business file set must be unchanged');
  for (const [rel, bytes] of before) {
    assert.deepEqual(after.get(rel), bytes, `business file changed: ${rel}`);
  }
}

async function loadCoordinator() {
  return import('../src/audit-integrity-dual-write.js');
}

async function loadState() {
  return import('../src/audit-integrity-dual-write-state.js');
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function isTestCrash(error, code) {
  return Boolean(error && error.code === code);
}

async function makeRecoverablePrepared(root) {
  const {
    appendAuditEventWithIntegrityDualWrite,
    DUAL_WRITE_TEST_CRASH_HOOK,
  } = await loadCoordinator();
  await assert.rejects(
    () => appendAuditEventWithIntegrityDualWrite(root, { ...SEED_EVENT }, {
      [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
    }),
    (e) => isTestCrash(e, 'TEST_CRASH_AFTER_PREPARED'),
  );
  const raw = await readFile(stateAbs(root), 'utf8');
  assert.match(raw, /"status"\s*:\s*"prepared"/);
}

async function makeUnrecoverablePrepared(root) {
  const {
    appendAuditEventWithIntegrityDualWrite,
    DUAL_WRITE_TEST_CRASH_HOOK,
  } = await loadCoordinator();
  const stateMod = await loadState();
  await assert.rejects(
    () => appendAuditEventWithIntegrityDualWrite(root, { ...SEED_EVENT }, {
      [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
    }),
    (e) => isTestCrash(e, 'TEST_CRASH_AFTER_PREPARED'),
  );
  const prepared = JSON.parse(await readFile(stateAbs(root), 'utf8'));
  // Deterministic recovery conflict: flip one hex nibble of journal.post.rawSha256.
  const badPostSha = prepared.journal.post.rawSha256.replace(/[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
  const mutated = {
    ...prepared,
    journal: {
      pre: { ...prepared.journal.pre },
      post: { ...prepared.journal.post, rawSha256: badPostSha },
    },
    events: {
      pre: { ...prepared.events.pre },
      post: { ...prepared.events.post },
    },
    event: { ...prepared.event },
    retention: prepared.retention,
  };
  await withLease(root, async (resolvedRoot, lease) => {
    await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, mutated);
  });
}

async function makeInvalidDualWriteState(root) {
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(stateAbs(root), 'occupied-invalid-state\n', { mode: 0o600 });
}

describe('V1.39 C1 write-admission — registry export surface', () => {
  it('exports exact frozen 6-route API_WRITE_ROUTES set and order', () => {
    assert.equal(API_WRITE_ROUTES.length, 6);
    assert.deepEqual(API_WRITE_ROUTES, [...FROZEN_WRITE_ROUTES]);
    for (const route of FROZEN_WRITE_ROUTES) {
      assert.equal(isApiWriteRoute(route.method, route.path), true);
    }
    assert.equal(isApiWriteRoute('GET', '/api/heartbeat'), false);
    assert.equal(isApiWriteRoute('POST', '/api/nas-dry-run'), false);
  });

  it('places central gate after auth/rate and before first write handler (source order)', async () => {
    const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
    const createIdx = source.indexOf('export function createServer');
    assert.ok(createIdx > 0, 'createServer export must exist');

    const rateIdx = source.indexOf('apiRateLimiter.check', createIdx);
    const authDeniedIdx = source.indexOf("type: 'auth.denied'", createIdx);
    const authForbiddenIdx = source.indexOf("type: 'auth.forbidden'", createIdx);

    // Central production call — exact await form (not definition; not a comment/string decoy).
    const gateCallNeedle = 'await recordRequiredWriteAdmissionAudit(';
    const gateCallIdx = source.indexOf(gateCallNeedle, createIdx);
    assert.ok(gateCallIdx > createIdx, 'await recordRequiredWriteAdmissionAudit production call must exist');

    // Same central block if: lastIndexOf exact if from the production call (avoids auth.forbidden branch).
    const gateIfNeedle = 'if (isApiWriteRoute(method, pathname))';
    const gateIfIdx = source.lastIndexOf(gateIfNeedle, gateCallIdx);
    assert.ok(gateIfIdx > createIdx, 'central gate if must exist before production call');

    // Same-block structural proof: between if and await, only `{` / whitespace (no other statements).
    const betweenGateIfAndCall = source.slice(gateIfIdx + gateIfNeedle.length, gateCallIdx);
    assert.ok(/^\s*\{\s*$/.test(betweenGateIfAndCall),
      'await recordRequiredWriteAdmissionAudit must be the first statement of the central gate if-block');

    // First write-route handler body after gate (device enrollment is first in handler).
    const firstWriteHandlerIdx = source.indexOf(
      "isExactApiRoute(url, method, 'POST', '/api/device-enrollment-codes')",
      createIdx,
    );

    assert.ok(rateIdx > createIdx, 'rate-limit check must be inside createServer');
    assert.ok(authDeniedIdx > rateIdx, 'auth denied must follow rate-limit');
    assert.ok(authForbiddenIdx > authDeniedIdx, 'auth forbidden must follow auth denied');
    // Complete auth block includes denied + forbidden branches; central gate-if must follow both.
    assert.ok(gateIfIdx > authForbiddenIdx,
      'central gate-if must sit after complete auth block (denied+forbidden)');
    assert.ok(gateCallIdx > gateIfIdx, 'production admission await must follow its gate-if');
    assert.ok(gateIfIdx < firstWriteHandlerIdx,
      'central gate-if must sit before first write handler');
    assert.ok(gateCallIdx < firstWriteHandlerIdx,
      'recordRequiredWriteAdmissionAudit must run before first write handler');

    // Exact-one production call site (definition + single call).
    const defMatches = source.match(/async function recordRequiredWriteAdmissionAudit\s*\(/g) || [];
    assert.equal(defMatches.length, 1, 'helper must be defined exactly once');
    const callMatches = source.match(/recordRequiredWriteAdmissionAudit\s*\(/g) || [];
    assert.equal(callMatches.length, 2, 'helper: one definition + one production call');
    assert.ok(!/recordRequiredWriteAdmissionAudit[\s\S]{0,200}\.catch\s*\(/.test(source),
      'required helper must not use .catch swallow');
  });
});

describe('V1.39 C1 write-admission — healthy / cold paths', () => {
  it('writes exact-one admission per write route on deterministic validation path (handler 4xx continues)', async () => {
    // Strategy: use deterministic validation bodies so each route reaches admission,
    // then returns its original 4xx without needing full business fixtures.
    // device admin routes need writeToken + deviceAdministration present.
    const spies = { issueEnrollment: 0, revokeDevice: 0 };
    await withServer({
      writeToken: 'admit-write-token',
      deviceAdministration: baseDeviceAdmin(spies),
    }, async ({ port, dataDir }) => {
      for (const route of API_WRITE_ROUTES) {
        const before = await listAdmissionEvents(dataDir);
        const beforeCount = before.length;
        const expected = expectedValidationStatus(route.path);
        const res = await postJson(
          port,
          route.path,
          validationBodyFor(route.path),
          'admit-write-token',
        );
        assert.equal(res.status, expected.status, `${route.path} status`);
        assert.deepEqual(res.json, { error: expected.error }, `${route.path} body`);

        const admissions = await listAdmissionEvents(dataDir);
        assert.equal(admissions.length, beforeCount + 1, `${route.path} exact-one new admission`);
        // Newest-first from readAuditEvents.
        const latest = admissions[0];
        assertAdmissionShape(latest, route);
        assert.ok(!(await readFile(eventsAbs(dataDir), 'utf8')).includes('admit-write-token'));
      }
      assert.equal(spies.issueEnrollment, 0);
      assert.equal(spies.revokeDevice, 0);
    });
  });

  it('writes admission before invalid body 4xx on heartbeat', async () => {
    await withServer({}, async ({ port, dataDir }) => {
      const res = await postJson(port, '/api/heartbeat', { hostname: 'only-host' });
      assert.equal(res.status, 400);
      assert.deepEqual(res.json, { error: 'deviceId is required' });
      const admissions = await listAdmissionEvents(dataDir);
      assert.equal(admissions.length, 1);
      assertAdmissionShape(admissions[0], { method: 'POST', path: '/api/heartbeat' });
      // Failure best-effort audit may also exist; admission must be present regardless.
      const types = (await readAuditEvents(dataDir, { limit: 20 })).map((e) => e.type);
      assert.ok(types.includes(ADMISSION_TYPE));
      assert.ok(types.includes('api.heartbeat.failure'));
    });
  });
});

describe('V1.39 C1 write-admission — fail-closed (invalid / unrecoverable)', () => {
  it('invalid dual-write state: all 6 write routes 503 fixed body; mutation spies zero; business bytes unchanged', async () => {
    const spies = { issueEnrollment: 0, revokeDevice: 0 };
    await withTempRoot('invalid', async (dataDir) => {
      await makeInvalidDualWriteState(dataDir);
      const beforeBiz = await snapshotBusinessBytes(dataDir);
      const stateBefore = await readFile(stateAbs(dataDir));
      const server = createServer({
        dataDir,
        writeToken: 'tok-invalid',
        deviceAdministration: baseDeviceAdmin(spies),
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      try {
        for (const route of API_WRITE_ROUTES) {
          const res = await postJson(port, route.path, mutationBodyFor(route.path), 'tok-invalid');
          assert.equal(res.status, 503, route.path);
          assert.deepEqual(res.json, { error: 'audit-delivery-unavailable' });
          assertNoLeakage(res.text, dataDir, 'tok-invalid');
        }
        assert.equal(spies.issueEnrollment, 0);
        assert.equal(spies.revokeDevice, 0);
        // Fail-closed: dual-write state bytes frozen; journal/events must not appear.
        assert.deepEqual(await readFile(stateAbs(dataDir)), stateBefore);
        await assert.rejects(() => access(journalAbs(dataDir)), { code: 'ENOENT' });
        await assert.rejects(() => access(eventsAbs(dataDir)), { code: 'ENOENT' });
        // Business snapshot (non-audit) still unchanged — do not skip for admission-count fallback.
        const afterBiz = await snapshotBusinessBytes(dataDir);
        assertBusinessUnchanged(beforeBiz, afterBiz);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it('unrecoverable prepared: all 6 write routes 503 fixed body; mutation spies zero; business bytes unchanged', async () => {
    const spies = { issueEnrollment: 0, revokeDevice: 0 };
    await withTempRoot('unrec', async (dataDir) => {
      await makeUnrecoverablePrepared(dataDir);
      const beforeBiz = await snapshotBusinessBytes(dataDir);
      const stateBefore = await readFile(stateAbs(dataDir));
      const journalBefore = await readFile(journalAbs(dataDir));
      let eventsBefore = null;
      try {
        eventsBefore = await readFile(eventsAbs(dataDir));
      } catch {
        eventsBefore = null;
      }

      const server = createServer({
        dataDir,
        writeToken: 'tok-unrec',
        deviceAdministration: baseDeviceAdmin(spies),
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      try {
        for (const route of API_WRITE_ROUTES) {
          const res = await postJson(port, route.path, mutationBodyFor(route.path), 'tok-unrec');
          assert.equal(res.status, 503, route.path);
          assert.deepEqual(res.json, { error: 'audit-delivery-unavailable' });
          assertNoLeakage(res.text, dataDir, 'tok-unrec');
          // Must not surface underlying dual-write codes on HTTP body.
          assert.ok(!res.text.includes('audit-integrity-dual-write-recovery-conflict'));
          assert.ok(!res.text.includes('audit-integrity-dual-write-state-invalid'));
        }
        assert.equal(spies.issueEnrollment, 0);
        assert.equal(spies.revokeDevice, 0);
        assertBusinessUnchanged(beforeBiz, await snapshotBusinessBytes(dataDir));
        assert.deepEqual(await readFile(stateAbs(dataDir)), stateBefore);
        assert.deepEqual(await readFile(journalAbs(dataDir)), journalBefore);
        if (eventsBefore === null) {
          await assert.rejects(() => access(eventsAbs(dataDir)), { code: 'ENOENT' });
        } else {
          assert.deepEqual(await readFile(eventsAbs(dataDir)), eventsBefore);
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

describe('V1.39 C1 write-admission — recoverable prepared positive', () => {
  it('legal recoverable prepared: auto-recover + admission + mutation proceeds (heartbeat)', async () => {
    await withTempRoot('recov', async (dataDir) => {
      await makeRecoverablePrepared(dataDir);
      const stateBefore = await readFile(stateAbs(dataDir), 'utf8');
      assert.match(stateBefore, /"status"\s*:\s*"prepared"/);

      const server = createServer({ dataDir });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      try {
        const res = await postJson(port, '/api/heartbeat', {
          deviceId: 'mac-recover-ok',
          hostname: 'host-r',
          ipAddress: '10.0.0.9',
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.deviceId, 'mac-recover-ok');

        const admissions = await listAdmissionEvents(dataDir);
        assert.equal(admissions.length, 1);
        assertAdmissionShape(admissions[0], { method: 'POST', path: '/api/heartbeat' });

        // Recovery + append may change state/events/journal — assert recovered idle + mutation.
        const stateAfter = JSON.parse(await readFile(stateAbs(dataDir), 'utf8'));
        assert.equal(stateAfter.status, 'idle');
        // Device mutation must have proceeded (device.json under repo/devices).
        const deviceJson = join(dataDir, 'repo', 'devices', 'mac-recover-ok', 'device.json');
        const device = JSON.parse(await readFile(deviceJson, 'utf8'));
        assert.equal(device.deviceId, 'mac-recover-ok');
        assert.equal(device.hostname, 'host-r');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

describe('V1.39 C1 write-admission — no gate on deny / read / dry-run', () => {
  it('auth denied does not write required admission; keeps best-effort auth.denied', async () => {
    await withServer({ authToken: 'secret-auth-token' }, async ({ port, dataDir }) => {
      const res = await postJson(port, '/api/heartbeat', { deviceId: 'mac-x' });
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'Unauthorized' });
      const admissions = await listAdmissionEvents(dataDir);
      assert.equal(admissions.length, 0);
      const events = await readAuditEvents(dataDir, { limit: 20 });
      assert.ok(events.some((e) => e.type === 'auth.denied'));
    });
  });

  it('auth forbidden (read token on write) does not write required admission', async () => {
    await withServer({
      readToken: 'read-only-token',
      writeToken: 'write-only-token',
    }, async ({ port, dataDir }) => {
      const res = await postJson(port, '/api/heartbeat', { deviceId: 'mac-x' }, 'read-only-token');
      assert.equal(res.status, 403);
      assert.deepEqual(res.json, { error: 'Forbidden' });
      assert.equal((await listAdmissionEvents(dataDir)).length, 0);
      const events = await readAuditEvents(dataDir, { limit: 20 });
      assert.ok(events.some((e) => e.type === 'auth.forbidden'));
    });
  });

  it('rate-limit denied does not write required admission; keeps best-effort api.rate_limited', async () => {
    await withServer({
      // Fixed now keeps both requests in one window (avoids real-clock minute-boundary flake).
      rateLimit: { maxRequests: 1, windowMs: 60_000, now: () => 1_000 },
    }, async ({ port, dataDir }) => {
      const first = await postJson(port, '/api/heartbeat', { deviceId: 'mac-rate-1' });
      assert.equal(first.status, 200);
      assert.equal((await listAdmissionEvents(dataDir)).length, 1);

      const second = await postJson(port, '/api/heartbeat', { deviceId: 'mac-rate-2' });
      assert.equal(second.status, 429);
      assert.deepEqual(second.json, { error: 'Rate limit exceeded' });
      // Still exactly one required admission (from first request only).
      assert.equal((await listAdmissionEvents(dataDir)).length, 1);
      const events = await readAuditEvents(dataDir, { limit: 20 });
      assert.ok(events.some((e) => e.type === 'api.rate_limited'));
    });
  });

  it('read-only and dry-run routes do not write required admission', async () => {
    await withServer({}, async ({ port, dataDir }) => {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);

      // nas-dry-run is not in API_WRITE_ROUTES; empty-ish body is accepted as dry-run plan.
      const dry = await postJson(port, '/api/nas-dry-run', { not: 'a-write-route' });
      assert.equal(dry.status, 200);
      assert.equal(dry.json.mode, 'dry-run');

      // supervisor-install-dry-run remains non-write; invalid config → 400, no admission.
      const preview = await postJson(port, '/api/supervisor-install-dry-run', {
        not: 'config',
      });
      assert.equal(preview.status, 400);

      const audit = await fetch(`http://127.0.0.1:${port}/api/audit-log`);
      assert.equal(audit.status, 200);

      assert.equal((await listAdmissionEvents(dataDir)).length, 0);
    });
  });
});

describe('V1.39 C1 write-admission — outer catch mapping', () => {
  it('maps only LinkeError(AUDIT_DELIVERY_UNAVAILABLE) to 503 fixed code; ordinary/other LinkeError 5xx stay Internal Server Error', async () => {
    // Ordinary Error with statusCode=503 via backup hook throw after admission succeeds.
    await withTempRoot('outer', async (dataDir) => {
      // Seed a real source file so createBackup reaches hooks.
      const sourceDir = join(dataDir, 'source-tree');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'f.txt'), 'x\n', { mode: 0o600 });

      const ordinaryServer = createServer({
        dataDir,
        backupHooks: {
          afterDirSetup: async () => {
            const err = new Error('raw secret path /Users/private/token=abc stack');
            err.statusCode = 503;
            throw err;
          },
        },
      });
      await new Promise((resolve) => ordinaryServer.listen(0, '127.0.0.1', resolve));
      try {
        const port = ordinaryServer.address().port;
        const res = await postJson(port, '/api/backups', {
          deviceId: 'mac-outer-ord',
          sourcePath: sourceDir,
        });
        assert.equal(res.status, 500);
        assert.deepEqual(res.json, { error: 'Internal Server Error' });
        assert.ok(!res.text.includes('/Users/private'));
        assert.ok(!res.text.includes('token=abc'));
        // Admission still succeeded once before mutation path threw.
        assert.equal((await listAdmissionEvents(dataDir)).length, 1);
      } finally {
        await new Promise((resolve) => ordinaryServer.close(resolve));
      }
    });

    await withTempRoot('outer2', async (dataDir) => {
      const sourceDir = join(dataDir, 'source-tree');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'f.txt'), 'x\n', { mode: 0o600 });

      const linkeServer = createServer({
        dataDir,
        backupHooks: {
          afterDirSetup: async () => {
            throw new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR, {
              statusCode: 503,
              retryable: true,
            });
          },
        },
      });
      await new Promise((resolve) => linkeServer.listen(0, '127.0.0.1', resolve));
      try {
        const port = linkeServer.address().port;
        const res = await postJson(port, '/api/backups', {
          deviceId: 'mac-outer-le',
          sourcePath: sourceDir,
        });
        assert.equal(res.status, 500);
        assert.deepEqual(res.json, { error: 'Internal Server Error' });
        assert.ok(!res.text.includes(ERROR_CODES.DEVICE_INTERNAL_ERROR));
      } finally {
        await new Promise((resolve) => linkeServer.close(resolve));
      }
    });

    // Fixed exception path via invalid dual-write (typed failure → remap).
    await withTempRoot('outer3', async (dataDir) => {
      await makeInvalidDualWriteState(dataDir);
      const server = createServer({ dataDir });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = server.address().port;
        const res = await postJson(port, '/api/heartbeat', { deviceId: 'mac-x' });
        assert.equal(res.status, 503);
        assert.deepEqual(res.json, { error: 'audit-delivery-unavailable' });
        assertNoLeakage(res.text, dataDir, null);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
