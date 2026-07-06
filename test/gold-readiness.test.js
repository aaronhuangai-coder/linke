import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildGoldReadinessReport } from '../src/gold-readiness.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

function evidenceText(item) {
  assert.ok(item, 'item should exist');
  assert.ok(Array.isArray(item.evidence), `item ${item.id || '(unknown)'} evidence should be an array`);
  assert.ok(item.evidence.length > 0, `item ${item.id} evidence array should not be empty`);
  for (const s of item.evidence) {
    assert.strictEqual(typeof s, 'string', `item ${item.id} evidence element should be a string`);
    assert.ok(s.length > 0, `item ${item.id} evidence element should not be empty`);
  }
  return item.evidence.join(' ');
}

describe('Gold Readiness Report', () => {
  it('expects LINKE_RELEASE_VERSION to be V0.54', () => {
    assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.54');
  });

  it('expects report.version to be V0.54', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    assert.strictEqual(report.version, 'V0.54');
  });

  it('expects status blocked and correct summary count', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    assert.strictEqual(report.status, 'blocked');
    assert.deepStrictEqual(report.summary, { ready: 4, partial: 3, blocked: 2, total: 9 });
  });

  it('verifies generatedAt timestamp is parsed from options.now', () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const report = buildGoldReadinessReport({ now });
    assert.strictEqual(report.generatedAt, "2026-07-06T12:00:00.000Z");
  });

  it('verifies report items are deterministic and static when now changes', () => {
    const now1 = new Date("2026-07-06T12:00:00.000Z");
    const report1 = buildGoldReadinessReport({ now: now1 });
    const now2 = new Date("2026-07-06T15:30:00.000Z");
    const report2 = buildGoldReadinessReport({ now: now2 });

    assert.strictEqual(report1.generatedAt, "2026-07-06T12:00:00.000Z");
    assert.strictEqual(report2.generatedAt, "2026-07-06T15:30:00.000Z");

    const { generatedAt: g1, ...rest1 } = report1;
    const { generatedAt: g2, ...rest2 } = report2;
    assert.deepStrictEqual(rest1, rest2);
  });

  it('verifies correct list of item IDs', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const expectedIds = [
      'release-readiness',
      'local-backup-restore',
      'fleet-device-management',
      'version-consistency',
      'nas-dry-run',
      'automation-installation',
      'security-auth',
      'real-nas-remote-backup',
      'production-hardening'
    ];
    const actualIds = report.items.map(item => item.id);
    assert.deepStrictEqual(actualIds, expectedIds);
  });

  it('verifies concrete evidence strings for release-readiness and local-backup-restore', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });

    const rrItem = report.items.find(item => item.id === 'release-readiness');
    assert.ok(rrItem, 'release-readiness item should exist');
    const rrEvidence = evidenceText(rrItem);
    assert.ok(rrEvidence.includes('test/release-readiness.test.js'));
    assert.ok(rrEvidence.includes('test/agent-release-readiness.test.js'));
    assert.ok(rrEvidence.includes('test/health.test.js'));
    assert.ok(rrEvidence.includes('GET /api/health'));
    assert.ok(rrEvidence.includes('GET /api/release-readiness'));

    const lbrItem = report.items.find(item => item.id === 'local-backup-restore');
    assert.ok(lbrItem, 'local-backup-restore item should exist');
    const lbrEvidence = evidenceText(lbrItem);
    assert.ok(lbrEvidence.includes('test/restore.test.js'));
    assert.ok(lbrEvidence.includes('test/restore-dry-run.test.js'));
    assert.ok(lbrEvidence.includes('test/manifest.test.js'));
    assert.ok(lbrEvidence.includes('test/concurrency.test.js'));
    assert.ok(lbrEvidence.includes('test/security.test.js'));
  });

  it('verifies limits and details on fleet-device-management and nas-dry-run items', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });

    const fleetItem = report.items.find(item => item.id === 'fleet-device-management');
    assert.ok(fleetItem, 'fleet-device-management item should exist');
    const fleetEvidence = evidenceText(fleetItem);
    assert.ok(fleetEvidence.includes('test/heartbeat.test.js'));
    assert.ok(fleetEvidence.includes('test/web-console.test.js'));

    const fleetCombined = `${fleetItem.label || ''} ${fleetItem.nextStep || ''} ${fleetEvidence}`;
    assert.ok(
      fleetCombined.toLowerCase().includes('read-only snapshot') ||
      fleetCombined.toLowerCase().includes('heartbeat-state')
    );
    assert.ok(!fleetCombined.toLowerCase().includes('real-time discovery'));
    assert.ok(!fleetCombined.toLowerCase().includes('production monitoring'));

    const nasItem = report.items.find(item => item.id === 'nas-dry-run');
    assert.ok(nasItem, 'nas-dry-run item should exist');
    const nasEvidence = evidenceText(nasItem);
    assert.ok(nasEvidence.includes('test/nas-dry-run.test.js'));
    assert.ok(nasEvidence.includes('test/config.test.js'));

    const nasCombined = `${nasItem.label || ''} ${nasItem.nextStep || ''} ${nasEvidence}`;
    assert.ok(nasCombined.toLowerCase().includes('real nas connection'));
    assert.ok(
      nasCombined.toLowerCase().includes('deny') ||
      nasCombined.toLowerCase().includes('denies') ||
      nasCombined.toLowerCase().includes('no ') ||
      nasCombined.toLowerCase().includes('not supported')
    );
  });

  it('verifies security-auth is partial while real-nas-remote-backup and production-hardening remain blocked', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const securityItem = report.items.find(item => item.id === 'security-auth');
    assert.ok(securityItem, 'security-auth should exist');
    assert.strictEqual(securityItem.status, 'partial');
    const securityEvidence = evidenceText(securityItem);
    assert.ok(securityEvidence.includes('test/security.test.js'));
    assert.ok(securityEvidence.includes('test/agent-health.test.js'));
    assert.ok(securityEvidence.includes('test/web-console.test.js'));
    assert.ok(securityEvidence.includes('src/web/app.js'));
    assert.ok(securityEvidence.includes('Authorization: Bearer'));
    assert.doesNotMatch(securityItem.nextStep, /Web token UX/i);
    assert.match(securityItem.nextStep, /authorization|secret|production/i);

    const blockedIds = ['real-nas-remote-backup', 'production-hardening'];
    for (const id of blockedIds) {
      const item = report.items.find(item => item.id === id);
      assert.ok(item, `${id} should exist`);
      assert.strictEqual(item.status, 'blocked');
    }
  });

  it('rejects vague evidence strings like implemented, works, done, available', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const vagueWords = ['implemented', 'works', 'done', 'available'];
    for (const item of report.items) {
      const evidence = evidenceText(item).toLowerCase();
      for (const word of vagueWords) {
        assert.ok(
          !evidence.includes(word),
          `evidence for item "${item.id}" contains vague word "${word}": "${item.evidence}"`
        );
      }
    }
  });

  it('verifies that descriptive text distinguishes Gold from release readiness and explains Gold can remain blocked', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    assert.ok(typeof report.description === 'string' || typeof report.note === 'string');
    const text = report.description || report.note || '';

    assert.match(text, /gold/i);
    assert.match(text, /release readiness/i);
    assert.match(text, /blocked/i);
    assert.match(
      text,
      /(healthy|passing|ok)/i,
      'Explanation must reference release readiness status like healthy/passing/ok'
    );
  });
});
