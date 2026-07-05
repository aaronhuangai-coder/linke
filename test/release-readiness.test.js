import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildReleaseReadinessReport } from '../src/release-readiness.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

function currentHealth(overrides = {}) {
  const { checks = {}, ...rest } = overrides;
  return {
    status: 'ok',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    checks: {
      http: 'ok',
      dataDirReadable: 'ok',
      ...checks,
    },
    timestamp: '2026-07-06T00:00:00.000Z',
    ...rest,
  };
}

function getCheck(report, id) {
  const check = report.checks.find((item) => item.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

describe('Release readiness report', () => {
  it('marks current ok health as ready with all checks passing', () => {
    const report = buildReleaseReadinessReport(currentHealth(), {
      now: new Date('2026-07-06T01:00:00.000Z'),
    });

    assert.strictEqual(report.ready, true);
    assert.strictEqual(report.service, 'linke');
    assert.strictEqual(report.expectedVersion, LINKE_RELEASE_VERSION);
    assert.strictEqual(report.actualVersion, LINKE_RELEASE_VERSION);
    assert.strictEqual(report.status, 'ok');
    assert.strictEqual(report.checkedAt, '2026-07-06T01:00:00.000Z');
    assert.deepStrictEqual(report.checks.map((check) => check.id), [
      'health.schema',
      'health.status',
      'health.service',
      'release.version',
      'health.checks.http',
      'health.checks.dataDirReadable',
      'health.timestamp',
    ]);
    assert.ok(report.checks.every((check) => check.ok));
  });

  it('marks degraded health as not ready with status and dataDir checks failed', () => {
    const report = buildReleaseReadinessReport(currentHealth({
      status: 'degraded',
      checks: { dataDirReadable: 'unavailable' },
    }));

    assert.strictEqual(report.ready, false);
    assert.strictEqual(getCheck(report, 'health.status').ok, false);
    assert.strictEqual(getCheck(report, 'health.checks.dataDirReadable').ok, false);
    assert.strictEqual(getCheck(report, 'health.checks.http').ok, true);
  });

  it('marks expected-version mismatch as not ready', () => {
    const report = buildReleaseReadinessReport(currentHealth(), {
      expectedVersion: 'V0.0',
    });

    assert.strictEqual(report.ready, false);
    assert.strictEqual(report.expectedVersion, 'V0.0');
    assert.strictEqual(report.actualVersion, LINKE_RELEASE_VERSION);
    assert.strictEqual(getCheck(report, 'release.version').ok, false);
  });

  it('rejects unexpected health fields without echoing field values', () => {
    const leakedPath = '/private/tmp/linke-secret-data-dir';
    const report = buildReleaseReadinessReport(currentHealth({
      dataDir: leakedPath,
    }));
    const serialized = JSON.stringify(report);

    assert.strictEqual(report.ready, false);
    assert.strictEqual(getCheck(report, 'health.schema').ok, false);
    assert.match(getCheck(report, 'health.schema').actual, /dataDir/);
    assert.ok(!serialized.includes(leakedPath), 'readiness report must not echo leaked path values');
  });
});
