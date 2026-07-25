import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildHealthResponse } from '../src/server.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

const README_PATH = resolve(import.meta.dirname, '..', 'README.md');

/** Exact positive signature ceiling for V1.43. */
const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';

/** Exact historical V1.42 signature — retained G0c base; must not be erased. */
const V142_SIGNATURE =
  'V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation';

/** Exact historical V1.41 signature — retained G0b base; must not be erased. */
const V141_SIGNATURE =
  'V1.41 G0b resumable manifest v2 snapshot upload implementation';

/** Exact historical V1.40 signature — retained process-lock base; must not be erased. */
const V140_SIGNATURE =
  'V1.40 local multi-process audit integrity write exclusive lock implementation';

/** Exact historical V1.39 signature — retained write-admission base; must not be erased. */
const V139_SIGNATURE =
  'V1.39 safety-critical audit write-admission fail-closed implementation';

/** Exact historical V1.38 signature — retained base; must not be erased. */
const V138_SIGNATURE =
  'V1.38 read-only audit integrity run-once monitor/alert implementation';

/** Required honesty boundary phrases — must appear on currentSurface only. */
const HONESTY_BOUNDARIES = Object.freeze([
  'T6d.3 still partial',
  'not T6d.3 complete',
  'not M6d Exit',
  'not production-hardening ready',
  'not Gold',
  'Gold remains blocked 4/4/1/9',
  'not end-to-end production audit delivery',
]);

/** Ambiguous slash aggregate that must not appear as current-state wording. */
const STALE_SLASH_AGGREGATE =
  'no journal rotation / managed scheduler / remote notification delivery';

/**
 * Stale standalone current claims — delivered by V1.40; must not remain on
 * V1.40 current surface (badge + current version-table row). Historical
 * V1.39/V1.38/V1.37 rows may still state them as past fact.
 */
const STALE_CURRENT_MULTI_PROCESS_DENY = 'not multi-process exclusive lock';
const STALE_SINGLE_PROCESS_QUEUE_ONLY = 'single-process queue only';
const STALE_MULTI_PROCESS_YET = 'not multi-process exclusive lock yet';

/**
 * Clause-local split for honesty canaries.
 * `;` / fullwidth `；` / `。` / `,` / `，` / period+space / emdash / endash / `--`.
 */
function splitHonestyClauses(text) {
  return String(text)
    .split(/[;；。,，—–]|--|\.(?=\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * True when every clause that mentions positivePhrase also contains a *direct*
 * same-clause negation: `not <phrase>` or `no <phrase>` (case-insensitive).
 * Arbitrary elsewhere `not`/`no` does NOT count as a shield.
 */
function barePositiveIsNegatedInSameClause(text, positivePhrase) {
  const positive = positivePhrase.toLowerCase();
  for (const clause of splitHonestyClauses(text)) {
    const lower = clause.toLowerCase();
    if (!lower.includes(positive)) continue;
    const hasDirect =
      lower.includes(`not ${positive}`) || lower.includes(`no ${positive}`);
    if (!hasDirect) return false;
  }
  return true;
}

function extractCurrentSurface(readme) {
  const lines = readme.split('\n');
  const badgeStart = lines.findIndex((l) =>
    l.includes(`**当前版本：${LINKE_RELEASE_VERSION}**`),
  );
  assert.ok(badgeStart >= 0, 'README must have current-version badge');
  const badgeLines = [];
  for (let i = badgeStart; i < lines.length; i += 1) {
    if (!lines[i].startsWith('>')) break;
    badgeLines.push(lines[i]);
  }
  const badge = badgeLines.join('\n');
  const currentRow = lines.find(
    (line) => line.includes(`| ${LINKE_RELEASE_VERSION} |`) && line.includes('当前版本'),
  );
  assert.ok(currentRow, `README version table current row for ${LINKE_RELEASE_VERSION} must exist`);
  return { badge, currentRow, currentSurface: `${badge}\n${currentRow}`, lines };
}

describe('Release Version Consistency', () => {
  it('LINKE_RELEASE_VERSION is defined and starts with V', () => {
    assert.strictEqual(typeof LINKE_RELEASE_VERSION, 'string');
    assert.ok(LINKE_RELEASE_VERSION.startsWith('V'));
  });

  it('LINKE_RELEASE_VERSION is the V1.43 milestone', () => {
    assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.43');
    assert.ok(!LINKE_RELEASE_VERSION.includes('G0c'));
    assert.ok(!LINKE_RELEASE_VERSION.includes('G0b'));
    assert.notStrictEqual(LINKE_RELEASE_VERSION, V143_SIGNATURE);
    assert.notStrictEqual(LINKE_RELEASE_VERSION, V142_SIGNATURE);
    assert.notStrictEqual(LINKE_RELEASE_VERSION, V141_SIGNATURE);
  });

  it('README title matches LINKE_RELEASE_VERSION', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const firstLine = readme.split('\n')[0].trim();
    assert.strictEqual(firstLine, `# Linke ${LINKE_RELEASE_VERSION}`);
  });

  it('README badge matches LINKE_RELEASE_VERSION', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    assert.ok(
      readme.includes(`**当前版本：${LINKE_RELEASE_VERSION}**`),
      'README badge must match current version',
    );
  });

  it('README version table marks LINKE_RELEASE_VERSION as 当前版本', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const lines = readme.split('\n');
    const versionRow = lines.find((line) => line.includes(`| ${LINKE_RELEASE_VERSION} |`));
    assert.ok(versionRow, `README version table must contain row for version ${LINKE_RELEASE_VERSION}`);
    assert.ok(
      versionRow.includes('当前版本'),
      `Version table row for ${LINKE_RELEASE_VERSION} must be marked as "当前版本"`,
    );
  });

  it('README current surface carries V1.43 exact signature and honesty boundaries', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const { badge, currentRow, currentSurface, lines } = extractCurrentSurface(readme);

    // Exact V1.43 signature MUST be on currentSurface (badge + V1.43 row only)
    assert.ok(
      currentSurface.includes(V143_SIGNATURE),
      `README currentSurface must include exact signature: ${V143_SIGNATURE}`,
    );
    assert.ok(
      currentSurface.includes('G0c real-LAN evidence absent')
        || currentSurface.includes('real-LAN evidence absent'),
      'current surface must state G0c real-LAN evidence absent',
    );
    assert.ok(
      !/G0c real-LAN complete/i.test(currentSurface),
      'current surface must not claim G0c real-LAN complete',
    );

    // V1.43 precise current boundaries: explicit manual rotation delivered;
    // no automatic rotation; no scheduler; no remote notification; archive
    // append-only policy is not WORM/authenticity. Stale "no journal rotation
    // yet" wording must not remain on the current surface.
    assert.ok(
      /explicit (manual )?rotation delivered/i.test(currentSurface),
      'current surface must state explicit (manual) rotation delivered',
    );
    assert.ok(
      /no automatic rotation|not automatic rotation/i.test(currentSurface),
      'current surface must deny automatic rotation directly',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'automatic rotation'),
      'current surface: automatic rotation must be direct clause-local negated',
    );
    assert.ok(
      /append-only/i.test(currentSurface),
      'current surface must state archive append-only policy',
    );
    assert.ok(
      /not WORM|no WORM/i.test(currentSurface),
      'current surface must deny WORM directly',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'worm'),
      'current surface: worm must be direct clause-local negated',
    );
    assert.ok(
      /not authenticity|no authenticity|no external authenticity/i.test(currentSurface),
      'current surface must deny authenticity',
    );
    assert.ok(
      !currentSurface.includes('no journal rotation yet'),
      'current surface must not keep stale "no journal rotation yet" wording',
    );

    // Required honesty boundaries MUST each exact-include on currentSurface
    for (const phrase of HONESTY_BOUNDARIES) {
      assert.ok(
        currentSurface.includes(phrase),
        `README currentSurface must exact-include honesty boundary: ${phrase}`,
      );
    }

    // V1.42 historical G0c base retained on table
    const v142Row = lines.find(
      (line) => line.includes('| V1.42 |') && line.includes('历史版本'),
    );
    assert.ok(v142Row, 'README version table must retain V1.42 as 历史版本');
    assert.ok(
      v142Row.includes(V142_SIGNATURE),
      'V1.42 historical row must retain exact V1.42 G0c signature',
    );
    assert.ok(
      /auto harness|automatic harness/i.test(v142Row),
      'V1.42 historical row must retain G0c auto harness facts',
    );

    // V1.41 historical G0b base retained on table
    const v141Row = lines.find(
      (line) => line.includes('| V1.41 |') && line.includes('历史版本'),
    );
    assert.ok(v141Row, 'README version table must retain V1.41 as 历史版本');
    assert.ok(
      v141Row.includes(V141_SIGNATURE),
      'V1.41 historical row must retain exact V1.41 G0b signature',
    );

    // V1.40 historical process-lock base retained on table
    const v140Row = lines.find(
      (line) => line.includes('| V1.40 |') && line.includes('历史版本'),
    );
    assert.ok(v140Row, 'README version table must retain V1.40 as 历史版本');
    assert.ok(
      v140Row.includes(V140_SIGNATURE),
      'V1.40 historical row must retain exact V1.40 process-lock signature',
    );

    // Stale standalone current multi-process denials must not remain on current surface
    assert.ok(
      !currentSurface.includes(STALE_CURRENT_MULTI_PROCESS_DENY),
      'current surface must not keep stale standalone "not multi-process exclusive lock"',
    );
    assert.ok(
      !currentSurface.includes(STALE_SINGLE_PROCESS_QUEUE_ONLY),
      'current surface must not keep stale "single-process queue only"',
    );
    assert.ok(
      !currentSurface.includes(STALE_MULTI_PROCESS_YET),
      'current surface must not keep stale remaining "not multi-process exclusive lock yet"',
    );

    // V1.39 historical write-admission base must remain
    const v139Row = lines.find(
      (line) => line.includes('| V1.39 |') && line.includes('历史版本'),
    );
    assert.ok(v139Row, 'README version table must retain V1.39 as 历史版本');
    assert.ok(
      v139Row.includes(V139_SIGNATURE),
      'V1.39 historical row must retain exact V1.39 write-admission signature',
    );
    assert.ok(
      /write-admission|pre-side-effect|recordRequiredWriteAdmissionAudit|recordRequiredNasReplicationStartAudit|audit-delivery-unavailable/i.test(v139Row),
      'V1.39 historical row must retain write-admission facts',
    );

    // V1.38 historical monitor base must remain
    const v138Row = lines.find(
      (line) => line.includes('| V1.38 |') && line.includes('历史版本'),
    );
    assert.ok(v138Row, 'README version table must retain V1.38 as 历史版本');
    assert.ok(
      v138Row.includes(V138_SIGNATURE),
      'V1.38 historical row must retain exact V1.38 monitor signature',
    );
    assert.ok(
      /T6d\.4 minimum viable run-once path delivered|audit-integrity-monitor|local run-once/i.test(v138Row),
      'V1.38 historical row must retain T6d.4 / monitor base facts',
    );

    // V1.37 historical dual-write base must remain (may retain historical multi-process-not-yet wording)
    const v137Row = lines.find(
      (line) => line.includes('| V1.37 |') && line.includes('历史版本'),
    );
    assert.ok(v137Row, 'README version table must retain V1.37 as 历史版本');
    assert.ok(
      /dual-write|journal-first/i.test(v137Row),
      'V1.37 historical row must retain dual-write / journal-first base',
    );

    // Monitor CLI path must still be documented (historical base; anywhere in README is fine)
    assert.ok(
      readme.includes('node src/agent.js audit-integrity-monitor --data-dir')
        || readme.includes('audit-integrity-monitor --data-dir'),
      'README must document audit-integrity-monitor CLI example',
    );

    // Stale V1.37 slash-aggregate current-state wording must not remain on current surface
    assert.ok(
      !badge.includes('no journal rotation / monitor / alert')
        && !badge.includes('no journal rotation/monitor/alert')
        && !currentRow.includes('no journal rotation / monitor / alert')
        && !currentRow.includes('no journal rotation/monitor/alert'),
      'current surface must not keep stale "no journal rotation / monitor / alert" wording',
    );
    assert.ok(
      !currentSurface.includes(STALE_SLASH_AGGREGATE),
      'current surface must not keep ambiguous slash aggregate for rotation/scheduler/remote',
    );
    // Prefer explicit direct negatives on current surface.
    // V1.43 delivers explicit manual rotation, so journal rotation itself is no
    // longer denied; automatic rotation is denied in the V1.43 boundary block.
    assert.ok(
      /not managed scheduler|no managed scheduler/i.test(currentSurface),
      'current surface must deny managed scheduler directly',
    );
    assert.ok(
      /not remote notification delivery|no remote notification delivery/i.test(currentSurface),
      'current surface must deny remote notification delivery directly',
    );
    assert.ok(
      /not production monitoring ready|no production monitoring ready/i.test(currentSurface),
      'current surface must deny production monitoring ready',
    );
  });

  it('hostile honesty canaries: bare positives not sheltered by arbitrary Not or limitation text', () => {
    // Bare positives must fail when not directly negated
    assert.equal(
      barePositiveIsNegatedInSameClause('production monitoring ready', 'production monitoring ready'),
      false,
      'hostile canary: bare production monitoring ready must fail',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause('remote notification delivery', 'remote notification delivery'),
      false,
      'hostile canary: bare remote notification delivery must fail',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause('managed scheduler', 'managed scheduler'),
      false,
      'hostile canary: bare managed scheduler must fail',
    );

    // Same-clause *direct* negatives pass
    assert.equal(
      barePositiveIsNegatedInSameClause('not production monitoring ready', 'production monitoring ready'),
      true,
      'hostile canary: same-clause not production monitoring ready must pass',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause('Not remote notification delivery', 'remote notification delivery'),
      true,
      'hostile canary: same-clause Not remote notification delivery must pass',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause('not managed scheduler', 'managed scheduler'),
      true,
      'hostile canary: same-clause not managed scheduler must pass',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause('no managed scheduler', 'managed scheduler'),
      true,
      'hostile canary: same-clause no managed scheduler must pass',
    );

    // Early Not / old limitation must NOT shelter a later bare positive
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'Not T6d.3 complete; production monitoring ready',
        'production monitoring ready',
      ),
      false,
      'hostile canary: early Not other must not shelter later bare production monitoring ready',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'T6d.3 still partial; remote notification delivery',
        'remote notification delivery',
      ),
      false,
      'hostile canary: partial limitation must not shelter bare remote notification delivery',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'not production monitoring ready; managed scheduler',
        'managed scheduler',
      ),
      false,
      'hostile canary: early not-other must not shelter later bare managed scheduler',
    );

    // Same-clause arbitrary "not" without direct "not <phrase>" must fail
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'not T6d.3 complete but production monitoring ready',
        'production monitoring ready',
      ),
      false,
      'hostile canary: same-clause not-other must not shelter bare production monitoring ready',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'not T6d.3 complete but remote notification delivery',
        'remote notification delivery',
      ),
      false,
      'hostile canary: same-clause not-other must not shelter bare remote notification delivery',
    );
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'no journal rotation / managed scheduler / remote notification delivery',
        'managed scheduler',
      ),
      false,
      'hostile canary: slash aggregate must not count as direct no managed scheduler',
    );

    // Multi-clause all-negated control
    assert.equal(
      barePositiveIsNegatedInSameClause(
        'Not remote notification delivery; not managed scheduler; not production monitoring ready',
        'production monitoring ready',
      ),
      true,
      'control: all-negated multi-clause honesty template must pass',
    );
  });

  it('README current surface negates remote/scheduler/production-monitoring with direct not/no', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const { currentSurface } = extractCurrentSurface(readme);

    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'production monitoring ready'),
      'README current surface: production monitoring ready must be direct clause-local negated',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'remote notification delivery'),
      'README current surface: remote notification delivery must be direct clause-local negated',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'managed scheduler'),
      'README current surface: managed scheduler must be direct clause-local negated',
    );
  });

  it('buildHealthResponse version matches LINKE_RELEASE_VERSION', () => {
    const res = buildHealthResponse({ dataDirReadable: true });
    assert.strictEqual(res.version, LINKE_RELEASE_VERSION);
  });
});
