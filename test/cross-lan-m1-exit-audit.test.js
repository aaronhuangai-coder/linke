/**
 * Linke V2 Gold M1 Exit audit static lock test.
 *
 * Locks the written M1 Exit audit record and runtime honesty snapshot.
 * Does NOT claim M1 PASS/COMPLETE, crypto ready, fixed-vector execution,
 * cross-LAN ready, route selection, or scorecard/version mutation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoldReadinessReport } from '../src/gold-readiness.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import * as protocol from '../src/cross-lan-protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_PATH = join(
  ROOT,
  'docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md',
);
const KEYCHAIN_TEST_PATH = join(ROOT, 'test/keychain-real.integration.test.js');
const PROTOCOL_SRC_PATH = join(ROOT, 'src/cross-lan-protocol.js');
const PROTOCOL_TEST_PATH = join(ROOT, 'test/cross-lan-protocol.test.js');
const PACKAGE_JSON_PATH = join(ROOT, 'package.json');
const TEST_DIR = join(ROOT, 'test');
const FIXTURES_DIR = join(ROOT, 'test/fixtures');
const THIS_AUDIT_TEST_REL = 'test/cross-lan-m1-exit-audit.test.js';
const PROTOCOL_TEST_REL = 'test/cross-lan-protocol.test.js';

const REQUIRED_MARKERS = Object.freeze([
  'M1_EXIT_AUDIT_EXECUTED: TRUE',
  'M1_EXIT_STATUS: BLOCKED_RECORDED',
  'M1_MILESTONE_PASS: FALSE',
  'M1_NON_CRYPTO_SCAFFOLD_COVERAGE: COMPLETE',
  'M1_CRYPTO_READY: FALSE',
  'T1_12_FIXED_VECTOR_EXECUTION: ABSENT_NOT_RUN_NOT_SKIPPED',
  'T1_0_ROUTE_DECISION: OPEN_PENDING_USER_SELECTION',
  'T1_0_ROUTE_DEADLINE: 2026-07-23T23:59:00+08:00',
  'M2_PRODUCTION_HANDSHAKE_ENTRY: DENIED',
  'SCORECARD_MUTATION: NONE',
  'VERSION_MUTATION: NONE',
]);

const TASK_COMMIT_ROWS = Object.freeze([
  ['T1.0', 'd00554e'],
  ['T1.1', 'aedf33b'],
  ['T1.1', '3589f46'],
  ['T1.2', '409ebfb'],
  ['T1.2', '5a08cea'],
  ['T1.3', 'b043d41'],
  ['T1.4', '7cac666'],
  ['T1.5', '6a5b38e'],
  ['T1.6', 'b6b4b24'],
  ['T1.7', '0d1ace4'],
  ['T1.8', '710a159'],
  ['T1.9', 'f732c1a'],
  ['T1.10', 'fdbd573'],
  ['T1.11', '0ac3f5e'],
  ['T1.12', 'd958c35'],
  ['T1.13', '4bf777a'],
  ['T1.13', 'ff2615d'],
  ['T1.13', 'a06cf17'],
  ['T1.14', 'f42523b'],
  ['T1.15', 'e24c863'],
  ['T1.16', '1aab3e9'],
  ['T1.17', '6972056'],
  ['T1.18', '872d7f3'],
  ['T1.19', 'a632259'],
  ['T1.20', '47dcc2d'],
]);

const FORBIDDEN_CLAIM_SNIPPETS = Object.freeze([
  'M1 PASS',
  'M1 COMPLETE',
  'M1 DONE',
  'crypto ready',
  'fixed vectors pass',
  'fixed vectors verified',
  'fixed vectors skipped',
  'cross-LAN ready',
  'cross-LAN partial-ready',
  'M2 handshake ready',
  'candidate selected',
  'route selected',
]);

function readAuditOrFail() {
  assert.equal(
    existsSync(AUDIT_PATH),
    true,
    `M1 exit audit document must exist at ${AUDIT_PATH}`,
  );
  return readFileSync(AUDIT_PATH, 'utf8');
}

function assertContains(haystack, needle, label = needle) {
  assert.equal(
    haystack.includes(needle),
    true,
    `expected audit to contain: ${label}`,
  );
}

function assertNotContainsIgnoreCase(haystack, needle, label = needle) {
  assert.equal(
    haystack.toLowerCase().includes(needle.toLowerCase()),
    false,
    `audit must not authorize or claim: ${label}`,
  );
}

/**
 * Collect all .js files under test/ (deterministic sort).
 * Scope-controlled: only .js files under test/.
 */
function listTestJsFiles(dir = TEST_DIR, acc = []) {
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      listTestJsFiles(full, acc);
    } else if (st.isFile() && name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Strip block/line comments so denial prose in this audit test or T1.12a
 * negative docs does not false-positive as execution harness semantics.
 */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Affirmative fixed-vector / known-vector fixture load semantics.
 * Matches load/import of vector fixtures, not denial prose.
 */
function hasFixedVectorFixtureLoadSemantics(source) {
  const code = stripJsComments(source);
  const patterns = [
    /readFileSync\s*\(\s*[^)]*(?:fixtures|fixed[-_]?vector|known[-_]?vector|noise-ik)[^)]*\)/i,
    /(?:import|require)\s*\([^)]*(?:fixtures|fixed[-_]?vector|known[-_]?vector|noise-ik)/i,
    /from\s+['"][^'"]*(?:fixtures|fixed[-_]?vector|known[-_]?vector|noise-ik)[^'"]*['"]/i,
    /JSON\.parse\s*\(\s*readFileSync\s*\([^)]*(?:vector|noise-ik|fixture)/i,
    /\b(?:loadFixedVectors?|loadKnownVectors?|loadNoiseVectors?)\s*\(/i,
    /\b(?:fixedVectors?|knownAnswers?|knownVectors?)\s*[:=]/i,
  ];
  return patterns.some((re) => re.test(code));
}

/**
 * Affirmative handshake-hash / ciphertext assertion execution semantics.
 */
function hasHandshakeHashOrCiphertextAssertSemantics(source) {
  const code = stripJsComments(source);
  const patterns = [
    /\bassert(?:\.\w+)?\s*\([^;]{0,200}\b(?:handshakeHash|ciphertext|expectedCiphertext|expectedHandshakeHash)\b/i,
    /\b(?:handshakeHash|ciphertext)\b[^;\n]{0,80}(?:assert|deepEqual|strictEqual|equal)\b/i,
    /\b(?:expectedHandshakeHash|expectedCiphertext|expected_handshake_hash|expected_ciphertext)\b/i,
    /\b(?:verifyHandshakeHash|assertCiphertext|compareHandshakeHash|assertHandshakeHash)\s*\(/i,
  ];
  return patterns.some((re) => re.test(code));
}

/**
 * Noise / clatter production implementation dependency name (semantic),
 * avoiding unrelated substrings (e.g. "noisy", random package names without
 * noise/clatter as a path segment).
 */
function isNoiseOrClatterProductionDepName(name) {
  const lower = String(name).toLowerCase();
  if (lower === 'noise' || lower === 'clatter') return true;
  // scoped or path-like: @scope/noise-*, noise-protocol, clatter-js, etc.
  if (/(^|\/|@)[^/]*\bnoise[-_/]/.test(lower)) return true;
  if (/(^|\/|@)[^/]*\bclatter[-_/]/.test(lower)) return true;
  if (/(^|\/)noise$/.test(lower) || /(^|\/)clatter$/.test(lower)) return true;
  if (/[-_/]noise$/.test(lower) || /[-_/]clatter$/.test(lower)) return true;
  // common package tokens: noise-js, noiseprotocol, libp2p-noise, @chainsafe/...noise
  if (/\bnoiseprotocol\b/.test(lower) || /\blibp2p-noise\b/.test(lower)) {
    return true;
  }
  if (/\bnoise-protocol\b/.test(lower) || /\bnoise_protocol\b/.test(lower)) {
    return true;
  }
  if (/\bclatter\b/.test(lower)) return true;
  // bare "noise" as final package segment: foo/noise, @x/noise
  if (/(^|\/)noise($|@)/.test(lower)) return true;
  return false;
}

/**
 * Supplementary only: test/fixtures absent, or no noise-ik / fixed-vector
 * fixture files under it. Never sufficient alone for T1.12 absence proof.
 */
function supplementaryFixturesVectorEvidence() {
  if (!existsSync(FIXTURES_DIR)) {
    return { fixturesDirExists: false, vectorFixturePaths: [] };
  }
  const hits = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const rel = relative(ROOT, full).replace(/\\/g, '/');
        if (/(?:noise-ik|fixed[-_]?vector|known[-_]?vector)/i.test(rel)) {
          hits.push(rel);
        }
      }
    }
  }
  walk(FIXTURES_DIR);
  return { fixturesDirExists: true, vectorFixturePaths: hits };
}

describe('Linke V2 M1 Exit audit lock', () => {
  it('audit document exists and carries exact exit marker block', () => {
    const audit = readAuditOrFail();

    for (const marker of REQUIRED_MARKERS) {
      assertContains(audit, marker);
    }

    // Exact contiguous marker block (order locked).
    const block = REQUIRED_MARKERS.join('\n');
    assertContains(audit, block, 'contiguous exact marker block');
  });

  it('records audit metadata: date, base HEAD, branch, worktree exception, authority, adversarial inputs', () => {
    const audit = readAuditOrFail();

    assertContains(audit, '2026-07-18');
    assertContains(audit, 'Asia/Shanghai');
    assertContains(audit, '47dcc2d');
    assertContains(audit, 'linke-v0.12-web-panel');
    assertContains(audit, 'package-lock.json');
    assertContains(audit, 'out of scope');

    assertContains(
      audit,
      'docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md',
    );
    assertContains(
      audit,
      'docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md',
    );
    assertContains(
      audit,
      'docs/superpowers/specs/2026-07-16-linke-v2-m1-noise-library-selection-adr.md',
    );
    assertContains(audit, '§6.7.7');
    assertContains(audit, 'GLM');
    assertContains(audit, 'Codex');
    assertContains(audit, 'PM');
  });

  it('T1.0–T1.20 matrix pins exact statuses and commits', () => {
    const audit = readAuditOrFail();

    for (const [task, commit] of TASK_COMMIT_ROWS) {
      assert.equal(
        audit.includes(task) && audit.includes(commit),
        true,
        `matrix must include ${task} with commit ${commit}`,
      );
    }

    assertContains(audit, 'T1.0');
    assertContains(audit, 'd00554e');
    assertContains(audit, 'BLOCKED');

    assertContains(audit, 'T1.12');
    assertContains(audit, 'T1.12a');
    assertContains(audit, 'd958c35');
    assertContains(audit, 'NOT COMPLETE');
    assertContains(audit, 'ABSENT_NOT_RUN_NOT_SKIPPED');

    assertContains(audit, 'T1.20');
    assertContains(audit, '47dcc2d');
  });

  it('baseline suite table separates actual Keychain skip from absent T1.12 fixed-vector test', () => {
    const audit = readAuditOrFail();

    assertContains(audit, '2226');
    assertContains(audit, '291');
    assertContains(audit, '2225');
    assertContains(audit, '0 fail');
    assertContains(audit, '1 skip');

    assertContains(audit, 'test/keychain-real.integration.test.js');
    assertContains(audit, 'skip: !enabled');
    assertContains(audit, 'LINKE_REAL_KEYCHAIN_TEST');
    assertContains(audit, 'unrelated to T1.12');

    assertContains(audit, 'ABSENT');
    assertContains(audit, 'NOT IMPLEMENTED');
    assertContains(audit, 'NOT RUN');
    assertContains(audit, 'does not satisfy the fixed-vector Exit requirement');

    // Must not equate suite skip with T1.12.
    assert.equal(
      /T1\.12[^\n]{0,120}skip/i.test(audit) &&
        !/T1\.12[^\n]{0,200}(ABSENT|NOT SKIPPED|not the suite skip)/i.test(audit),
      false,
      'must not describe T1.12 fixed-vector path as the suite skip',
    );
  });

  it('route window remains OPEN; deadline not expired; user selection pending', () => {
    const audit = readAuditOrFail();

    assertContains(audit, 'T1_0_ROUTE_DECISION: OPEN_PENDING_USER_SELECTION');
    assertContains(audit, 'T1_0_ROUTE_DEADLINE: 2026-07-23T23:59:00+08:00');
    assertContains(audit, '2026-07-23 23:59 Asia/Shanghai');
    assertContains(audit, 'OPEN');
    assertContains(audit, 'NOT EXPIRED');
    assertContains(audit, 'user has not made a written route 1/2/3 selection');
    assertContains(
      audit,
      'generic "continue to full Gold" is not a written route selection',
    );

    // Deadline OPEN semantics: audit date is before deadline.
    assertContains(audit, '2026-07-18');
    assert.equal(
      audit.includes('EXPIRED') && !audit.includes('NOT EXPIRED'),
      false,
      'deadline must be recorded as still OPEN / NOT EXPIRED',
    );
  });

  it('scorecard/version snapshot frozen; audit mutates neither', () => {
    const audit = readAuditOrFail();

    assertContains(audit, 'V1.33');
    assertContains(audit, '4 ready');
    assertContains(audit, '4 partial');
    assertContains(audit, '1 blocked');
    assertContains(audit, 'total: 9');
    assertContains(audit, 'cross-lan-connectivity');
    assertContains(audit, 'absent');
    assertContains(audit, 'SCORECARD_MUTATION: NONE');
    assertContains(audit, 'VERSION_MUTATION: NONE');
    assertContains(audit, 'neither is changed by the audit');
  });

  it('declares forbidden claims and negative declarations', () => {
    const audit = readAuditOrFail();

    assertContains(audit, 'Forbidden claims');
    for (const claim of FORBIDDEN_CLAIM_SNIPPETS) {
      assertContains(audit, claim);
    }

    // Negative declarations must deny these outcomes.
    assertContains(audit, 'must not claim');
    assertContains(audit, 'M1_MILESTONE_PASS: FALSE');
    assertContains(audit, 'M1_CRYPTO_READY: FALSE');
    assertContains(audit, 'M2_PRODUCTION_HANDSHAKE_ENTRY: DENIED');
  });

  it('records allowed vs forbidden next work while route decision pending', () => {
    const audit = readAuditOrFail();

    // P1-1: Allowed next work is ADR M1 non-crypto pure contracts only.
    assertContains(audit, 'Allowed next work');
    assertContains(audit, 'M1 non-crypto pure contracts only');
    assertContains(audit, 'error codes');
    assertContains(audit, 'message schemas');
    assertContains(audit, 'state-machine constants');
    assertContains(audit, 'equivalent pure scaffold');
    assertContains(audit, 'T1.0 BLOCKED');

    // M2 entry denied while T1.0 BLOCKED / route pending (not authorized).
    assertContains(audit, 'does not authorize M2 entry');
    assertContains(audit, 'M2 entry denied');
    assertContains(audit, 'mock-relay dry-run denied');
    assertContains(audit, 'relay framing implementation denied');
    assertContains(audit, 'topology implementation denied');

    // Must not positively authorize M2 tracks as Allowed next work.
    assert.equal(
      /Allowed next work[\s\S]*?Forbidden next work/i.test(audit) &&
        /Allowed next work[\s\S]*?(?:mock relay framing|lifecycle-isolation)/i.test(
          audit,
        ),
      false,
      'Allowed next work must not positively authorize mock relay framing / lifecycle-isolation M2 tracks',
    );

    assertContains(audit, 'Forbidden next work');
    assertContains(audit, 'Noise dependency');
    assertContains(audit, 'crypto/key generation');
    assertContains(audit, 'Keychain write');
    assertContains(audit, 'real cross-LAN');
    assertContains(audit, 'production handshake');
    assertContains(audit, 'scorecard/version elevation');
  });

  it('exit truth table and overall BLOCKED_RECORDED conclusion', () => {
    const audit = readAuditOrFail();

    assertContains(audit, 'Exit truth table');
    assertContains(audit, 'Written T1.0 BLOCKED branch: satisfied');
    assertContains(audit, 'Related unit tests including fixed vectors: unsatisfied');
    assertContains(audit, 'No real network/Keychain writes within new M1 work: satisfied');
    assertContains(
      audit,
      'Scorecard remains blocked and no partial cross-LAN ready claim: satisfied',
    );
    assertContains(audit, 'Terms/numerics spec alignment: satisfied');
    assertContains(audit, 'M1_EXIT_STATUS: BLOCKED_RECORDED');
    assertContains(audit, 'never PASS/COMPLETE');

    assertContains(audit, 'Sign-off');
    assertContains(audit, 'signs the audit record');
    assertContains(audit, 'not milestone PASS');
  });

  it('does not authorize route 1/2/3, dependency intro, M2 handshake, scorecard/version mutation', () => {
    const audit = readAuditOrFail();

    assertContains(audit, 'does not authorize route 1/2/3');
    assertContains(audit, 'does not authorize dependency introduction');
    assertContains(audit, 'does not authorize M2 production handshake');
    assertContains(audit, 'does not authorize scorecard/version mutation');

    // Positive authorization phrases must be absent.
    assertNotContainsIgnoreCase(
      audit,
      'authorizes route 1',
      'must not authorize route 1',
    );
    assertNotContainsIgnoreCase(
      audit,
      'authorizes M2 production handshake',
      'must not authorize M2 production handshake',
    );
  });

  it('runtime gold readiness snapshot remains V1.33 / blocked / 9 items / no cross-lan-connectivity', () => {
    assert.equal(LINKE_RELEASE_VERSION, 'V1.33');

    const report = buildGoldReadinessReport();
    assert.equal(report.version, 'V1.33');
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.summary, {
      ready: 4,
      partial: 4,
      blocked: 1,
      total: 9,
    });
    assert.equal(report.items.length, 9);

    const ids = report.items.map((item) => item.id);
    assert.equal(ids.includes('cross-lan-connectivity'), false);
    assert.equal(
      report.items.some((item) => item.id === 'cross-lan-connectivity'),
      false,
    );
  });

  it('actual suite skip is gated real Keychain integration (skip: !enabled), unrelated to T1.12', () => {
    const source = readFileSync(KEYCHAIN_TEST_PATH, 'utf8');

    assertContains(
      source,
      "process.env.LINKE_REAL_KEYCHAIN_TEST === 'enabled'",
      'Keychain real test gate env',
    );
    assertContains(
      source,
      "{ skip: !enabled }",
      'Keychain real test uses { skip: !enabled }',
    );
    assertContains(
      source,
      'real keychain create/update/get/delete/missing with fixed boolean diagnostics',
      'actual skip case identity',
    );

    // Not a T1.12 fixed-vector test.
    assert.equal(source.includes('T1.12'), false);
    assert.equal(source.includes('fixed vector'), false);
    assert.equal(source.includes('Noise'), false);
  });

  it('T1.12 fixed-vector ABSENT proven by multi-signal locks (not single fixture path)', () => {
    // --- (a) T1.12a source + test boundary markers ---
    const src = readFileSync(PROTOCOL_SRC_PATH, 'utf8');
    const testSrc = readFileSync(PROTOCOL_TEST_PATH, 'utf8');

    assertContains(src, 'T1.12a: non-crypto Noise IK token-sequence scaffold only');
    assertContains(src, 'T1.12 fixed vectors');
    assertContains(src, 'NOT READY / NOT COMPLETE');
    assertContains(src, 'T1.0 Noise library selection gate remains BLOCKED');
    assertContains(src, 'does not load fixtures');

    assertContains(
      testSrc,
      'T1.12a non-crypto Noise IK token-sequence scaffold only',
    );
    assertContains(testSrc, 'T1.12 fixed vectors');
    assertContains(testSrc, 'NOT READY / NOT COMPLETE');
    assertContains(testSrc, 'does not claim real Noise');
    assertContains(testSrc, 'implementations reject or that T1.12 is complete');

    // Exported scaffold API exists; does not equal full T1.12 fixed-vector execution.
    assert.ok(protocol.CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE);
    assert.deepEqual(protocol.CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE, {
      msg1: ['e', 'es', 's', 'ss'],
      msg2: ['e', 'ee', 'se'],
    });
    assert.equal(typeof protocol.matchesCrossLanNoiseIkTokenSequence, 'function');

    // --- (b) package.json: no selected/introduced Noise production deps ---
    const pkgRaw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const depNames = [];
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const block = pkg[field];
      if (block && typeof block === 'object') {
        depNames.push(...Object.keys(block));
      }
    }
    const noiseLikeDeps = depNames.filter(isNoiseOrClatterProductionDepName);
    assert.deepEqual(
      noiseLikeDeps,
      [],
      `package.json must not list Noise/clatter production deps; found: ${noiseLikeDeps.join(', ') || '(none)'}`,
    );

    // --- (c) Scope-controlled scan of test/ .js files for T1.12 execution harness ---
    // A harness is present only if a file has BOTH fixed-vector fixture/known-vector
    // load semantics AND handshake-hash/ciphertext assertion semantics.
    // Exclude: this audit lock test (self-strings) and treat protocol T1.12a
    // negative docs carefully via comment-strip + affirmative patterns only.
    const testJsFiles = listTestJsFiles();
    const harnessHits = [];
    for (const full of testJsFiles) {
      const rel = relative(ROOT, full).replace(/\\/g, '/');
      if (rel === THIS_AUDIT_TEST_REL) continue;

      const body = readFileSync(full, 'utf8');
      // T1.12a protocol test is negative documentation of non-execution; its
      // denial strings must not count. Affirmative patterns (after comment strip)
      // should already exclude it; still skip pure denial-only protocol test
      // when it lacks load+assert pair.
      const hasLoad = hasFixedVectorFixtureLoadSemantics(body);
      const hasAssert = hasHandshakeHashOrCiphertextAssertSemantics(body);
      if (hasLoad && hasAssert) {
        // Extra guard: if the only matches are inside T1.12a "does not …" denial
        // lines, strip those lines and re-check.
        const withoutDenialLines = body
          .split('\n')
          .filter(
            (line) =>
              !/\bdoes not\b/i.test(line) &&
              !/\bNOT READY\b/.test(line) &&
              !/\bNOT COMPLETE\b/.test(line) &&
              !/\bABSENT\b/.test(line) &&
              !/\bnon-crypto\b/i.test(line),
          )
          .join('\n');
        if (
          hasFixedVectorFixtureLoadSemantics(withoutDenialLines) &&
          hasHandshakeHashOrCiphertextAssertSemantics(withoutDenialLines)
        ) {
          harnessHits.push(rel);
        }
      }
    }
    assert.deepEqual(
      harnessHits,
      [],
      `T1.12 fixed-vector execution harness must be ABSENT; hits: ${harnessHits.join(', ') || '(none)'}`,
    );

    // Protocol T1.12a file must remain non-execution (no load+assert pair).
    assert.equal(
      hasFixedVectorFixtureLoadSemantics(testSrc) &&
        hasHandshakeHashOrCiphertextAssertSemantics(testSrc),
      false,
      `${PROTOCOL_TEST_REL} must not be a T1.12 fixed-vector execution harness`,
    );

    // --- (d) fixtures path evidence is supplementary only (not sufficient alone) ---
    const fixturesEvidence = supplementaryFixturesVectorEvidence();
    // Record supplementary emptiness; multi-signal (a)(b)(c) above are the proof.
    assert.equal(
      fixturesEvidence.vectorFixturePaths.length,
      0,
      `supplementary: vector/noise-ik fixture glob should be empty; found: ${fixturesEvidence.vectorFixturePaths.join(', ')}`,
    );
    // Explicitly do NOT treat a single hard-coded fixture path as full-repo proof.
    // (Single-path non-existence alone is insufficient; kept only as optional note.)

    const audit = readAuditOrFail();
    assertContains(audit, 'T1_12_FIXED_VECTOR_EXECUTION: ABSENT_NOT_RUN_NOT_SKIPPED');
    assert.equal(
      audit.includes('T1.12 fixed-vector execution test is ABSENT'),
      true,
    );
  });
});
