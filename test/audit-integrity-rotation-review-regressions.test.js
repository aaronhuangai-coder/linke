/**
 * Linke V1.43 Task 4 review regressions (P1-A / P1-B) — RED only.
 * Independent suite; does not alter frozen R1-R9 top-level contract.
 * Dynamic namespace import only. No skip/todo/only. No production bypass.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watch, readFileSync, writeFileSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROTATION_MODULE_SPEC = '../src/audit-integrity-rotation.js';
const DUAL_WRITE_MODULE_SPEC = '../src/audit-integrity-dual-write.js';
const DUAL_WRITE_STATE_MODULE_SPEC = '../src/audit-integrity-dual-write-state.js';
const ROTATION_STATE_MODULE_SPEC = '../src/audit-integrity-rotation-state.js';

const CODE_CONFLICT = 'audit-integrity-rotation-conflict';

const CRASH_AFTER_EVENTS_POST = 'TEST_CRASH_AFTER_EVENTS_POST';
const CRASH_AFTER_NEW_IDLE = 'TEST_CRASH_AFTER_NEW_IDLE';

/** Fixed foreign archive-manifest bytes for same-call completed re-proof injection. */
const FOREIGN_COMPLETED_MANIFEST = '{"foreign":"completed-manifest-tamper"}';

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

function isTestCrash(error, code) {
  return Boolean(error && (error.code === code || error.message === code));
}

function assertRotationError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityRotationError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'));
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('/var/'));
  assert.ok(!error.message.includes('/private/'));
  assert.ok(!error.message.includes('/tmp/'));
  assert.ok(!error.message.includes('Users/'));
  assert.ok(!error.message.includes('errno'));
  assert.ok(!error.message.includes('foreign'));
  assert.ok(!error.message.includes(FOREIGN_COMPLETED_MANIFEST));
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  return true;
}

async function loadRotation() {
  return import(ROTATION_MODULE_SPEC);
}

async function loadDualWrite() {
  return import(DUAL_WRITE_MODULE_SPEC);
}

async function loadDualWriteState() {
  return import(DUAL_WRITE_STATE_MODULE_SPEC);
}

async function loadRotationState() {
  return import(ROTATION_STATE_MODULE_SPEC);
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-rot-rev-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

function dualStateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function rotationStateAbs(root) {
  return join(root, 'audit', 'integrity-rotation-state.json');
}

function archiveDirAbs(root, generationId) {
  return join(root, 'audit', 'archive', generationId);
}

function archiveJournalAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'integrity-journal.jsonl');
}

function archiveEventsAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'events.jsonl');
}

function archiveManifestAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'manifest.json');
}

function auditDirAbs(root) {
  return join(root, 'audit');
}

async function createHealthyOneEventRoot(root) {
  const {
    recoverAuditIntegrityDualWrite,
    appendAuditEventWithIntegrityDualWrite,
  } = await loadDualWrite();
  await recoverAuditIntegrityDualWrite(root);
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
  const dualMod = await loadDualWriteState();
  const idle = dualMod.parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  assert.equal(idle.events.present, true);
  return {
    idle,
    expectedGenerationId: idle.generationId,
    expectedHeadDigest: idle.journal.headDigest,
    journalBytes: await readFile(journalAbs(root)),
    eventsBytes: await readFile(eventsAbs(root)),
    dualBytes: await readFile(dualStateAbs(root)),
  };
}

async function snapshotRotationBundle(root, previousGenerationId) {
  return {
    journal: await readFile(journalAbs(root)),
    events: await readFile(eventsAbs(root)),
    dual: await readFile(dualStateAbs(root)),
    rotation: await readFile(rotationStateAbs(root)),
    archJournal: await readFile(archiveJournalAbs(root, previousGenerationId)),
    archEvents: await readFile(archiveEventsAbs(root, previousGenerationId)),
    archManifest: await readFile(archiveManifestAbs(root, previousGenerationId)),
  };
}

function assertSnapEqual(a, b, label) {
  assert.deepEqual(a.journal, b.journal, `${label}: journal`);
  assert.deepEqual(a.events, b.events, `${label}: events`);
  assert.deepEqual(a.dual, b.dual, `${label}: dual`);
  assert.deepEqual(a.rotation, b.rotation, `${label}: rotation WAL`);
  assert.deepEqual(a.archJournal, b.archJournal, `${label}: archive journal`);
  assert.deepEqual(a.archEvents, b.archEvents, `${label}: archive events`);
  assert.deepEqual(a.archManifest, b.archManifest, `${label}: archive manifest`);
}

/**
 * Drive rotate to a named crash CP; return parsed WAL + fixtures.
 * @param {string} root
 * @param {string} hook
 * @param {string} crashCode
 */
async function crashRotateAt(root, hook, crashCode) {
  const fx = await createHealthyOneEventRoot(root);
  const rot = await loadRotation();
  await assert.rejects(
    () => rot.rotateAuditIntegrityGeneration(root, {
      expectedGenerationId: fx.expectedGenerationId,
      expectedHeadDigest: fx.expectedHeadDigest,
      [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: hook,
    }),
    (e) => isTestCrash(e, crashCode),
  );
  const stateMod = await loadRotationState();
  const wal = stateMod.parseAuditIntegrityRotationStateText(
    await readFile(rotationStateAbs(root), 'utf8'),
  );
  return { fx, rot, wal, stateMod };
}

describe('audit integrity rotation review regressions (Task 4 P1 RED)', () => {
  it('V143-REV1 WAL journal-published + live journal exact pre must CONFLICT without rewrite', async () => {
    await withTempRoot('rev1-wal-ahead-journal', async (root) => {
      // CP5: after-events-post → WAL journal-published; journal+events post; dual pre.
      const { fx, rot, wal } = await crashRotateAt(
        root,
        'after-events-post',
        CRASH_AFTER_EVENTS_POST,
      );
      assert.equal(wal.status, 'journal-published');
      assert.equal(wal.previousGenerationId, fx.expectedGenerationId);

      const archJournal = await readFile(
        archiveJournalAbs(root, fx.expectedGenerationId),
      );
      // Illegal reverse direction: WAL already journal-published, store back to exact pre.
      assert.notDeepEqual(await readFile(journalAbs(root)), archJournal);
      await writeFile(journalAbs(root), archJournal, { mode: 0o600 });
      assert.deepEqual(await readFile(journalAbs(root)), archJournal);

      const before = await snapshotRotationBundle(root, fx.expectedGenerationId);
      assert.equal(
        (await loadRotationState()).parseAuditIntegrityRotationStateText(
          before.rotation.toString('utf8'),
        ).status,
        'journal-published',
      );

      await assert.rejects(
        () => rot.recoverAuditIntegrityRotation(root),
        (e) => assertRotationError(e, CODE_CONFLICT, root),
      );

      const after = await snapshotRotationBundle(root, fx.expectedGenerationId);
      assertSnapEqual(after, before, 'V143-REV1 post-recover');
      // Live journal must remain the illegal exact-pre image (no silent rewrite to post).
      assert.deepEqual(after.journal, archJournal);
    });
  });

  it('V143-REV2 WAL events-published + live events exact pre must CONFLICT without rewrite', async () => {
    await withTempRoot('rev2-wal-ahead-events', async (root) => {
      // CP6: after-new-idle → WAL events-published; all live post.
      const { fx, rot, wal } = await crashRotateAt(
        root,
        'after-new-idle',
        CRASH_AFTER_NEW_IDLE,
      );
      assert.equal(wal.status, 'events-published');
      assert.equal(wal.previousGenerationId, fx.expectedGenerationId);

      const archEvents = await readFile(
        archiveEventsAbs(root, fx.expectedGenerationId),
      );
      assert.notDeepEqual(await readFile(eventsAbs(root)), archEvents);
      await writeFile(eventsAbs(root), archEvents, { mode: 0o600 });
      assert.deepEqual(await readFile(eventsAbs(root)), archEvents);

      const before = await snapshotRotationBundle(root, fx.expectedGenerationId);
      assert.equal(
        (await loadRotationState()).parseAuditIntegrityRotationStateText(
          before.rotation.toString('utf8'),
        ).status,
        'events-published',
      );

      await assert.rejects(
        () => rot.recoverAuditIntegrityRotation(root),
        (e) => assertRotationError(e, CODE_CONFLICT, root),
      );

      const after = await snapshotRotationBundle(root, fx.expectedGenerationId);
      assertSnapEqual(after, before, 'V143-REV2 post-recover');
      assert.deepEqual(after.events, archEvents);
    });
  });

  it('V143-REV3 same-call completed WAL then archive-manifest tamper must CONFLICT (no silent rotated)', async () => {
    await withTempRoot('rev3-completed-reproof', async (root) => {
      const fx = await createHealthyOneEventRoot(root);
      const rot = await loadRotation();
      const stateMod = await loadRotationState();
      const foreignBuf = Buffer.from(FOREIGN_COMPLETED_MANIFEST, 'utf8');

      const rotationAbs = rotationStateAbs(root);
      const auditDir = auditDirAbs(root);

      let injected = false;
      /** @type {Buffer|null} */
      let foreignWritten = null;
      /** @type {string|null} */
      let corruptedManifestPath = null;

      const tryInjectAfterCompletedWal = () => {
        if (injected) return;
        try {
          const walRaw = readFileSync(rotationAbs, 'utf8');
          const wal = stateMod.parseAuditIntegrityRotationStateText(walRaw);
          if (wal.status !== 'completed') return;
          const manAbs = archiveManifestAbs(root, wal.previousGenerationId);
          // Require durable manifest presence before overwrite.
          readFileSync(manAbs);
          writeFileSync(manAbs, foreignBuf);
          foreignWritten = Buffer.from(foreignBuf);
          corruptedManifestPath = manAbs;
          injected = true;
        } catch {
          // WAL not yet completed / not durable / parse mid-write — keep polling.
        }
      };

      // Watch audit tree (WAL leaf + archive) like A6; do not rely on wall-clock alone.
      let watcher;
      try {
        watcher = watch(auditDir, { recursive: true }, () => {
          tryInjectAfterCompletedWal();
        });
      } catch {
        // Platforms without recursive watch: still have the poller below.
        watcher = watch(auditDir, () => {
          tryInjectAfterCompletedWal();
        });
      }

      const pollerStop = { stop: false };
      const poller = (async () => {
        const deadline = Date.now() + 8000;
        while (!pollerStop.stop && !injected && Date.now() < deadline) {
          tryInjectAfterCompletedWal();
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();

      /** @type {{ ok: true, receipt: unknown } | { ok: false, error: unknown } | null} */
      let outcome = null;
      try {
        // Capture outcome without early assert.rejects so injection proof stays reachable.
        try {
          const receipt = await rot.rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: fx.expectedGenerationId,
            expectedHeadDigest: fx.expectedHeadDigest,
          });
          outcome = { ok: true, receipt };
        } catch (error) {
          outcome = { ok: false, error };
        }
      } finally {
        pollerStop.stop = true;
        if (watcher) watcher.close();
        await Promise.race([
          poller,
          new Promise((resolve) => setTimeout(resolve, 50)),
        ]);
      }

      // 1) Prove same-call injection and durable post-conditions first.
      assert.equal(
        injected,
        true,
        'V143-REV3 completed-WAL manifest tamper injection must have fired in-call',
      );
      assert.ok(corruptedManifestPath, 'corruptedManifestPath must be set');
      assert.ok(foreignWritten, 'foreignWritten must be set');
      assert.deepEqual(
        await readFile(corruptedManifestPath),
        foreignWritten,
        'foreign completed-manifest bytes must remain on disk (no repair)',
      );
      assert.equal(
        (await readFile(corruptedManifestPath)).toString('utf8'),
        FOREIGN_COMPLETED_MANIFEST,
      );

      const walAfter = stateMod.parseAuditIntegrityRotationStateText(
        await readFile(rotationAbs, 'utf8'),
      );
      assert.equal(walAfter.status, 'completed');

      // 2) Require path-free CONFLICT outcome (GREEN + RED share this structure).
      assert.ok(outcome, 'rotate outcome must be captured');
      if (outcome.ok) {
        const state = outcome.receipt
          && typeof outcome.receipt === 'object'
          && 'state' in outcome.receipt
          ? String(/** @type {{ state?: unknown }} */ (outcome.receipt).state)
          : typeof outcome.receipt;
        assert.fail(
          `rotate returned ${state} after completed-WAL manifest injection`,
        );
      }
      assertRotationError(outcome.error, CODE_CONFLICT, root);
    });
  });
});
