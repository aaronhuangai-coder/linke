/**
 * C3 / Task4.3: isolation / honesty / write-boundary scans for cross-store verifier.
 * Reads only explicit file paths (import.meta.url → repo root). No git. No recursive secret dirs.
 * Forbidden capability compound is assembled at runtime so this file does not self-trip.
 * Signature claim locked: V1.36 audit event/journal cross-store structural consistency
 * verifier implementation — not T6d.3 complete / production integration / Gold / authenticity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

/** Explicit allowlisted source paths only — never recursive secret dirs. */
const PATHS = Object.freeze({
  crossStore: join(REPO_ROOT, 'src/audit-integrity-cross-store.js'),
  journal: join(REPO_ROOT, 'src/audit-integrity-journal.js'),
  auditLog: join(REPO_ROOT, 'src/audit-log.js'),
  server: join(REPO_ROOT, 'src/server.js'),
  agent: join(REPO_ROOT, 'src/agent.js'),
  capabilitySink: join(REPO_ROOT, 'src/capability-audit-sink.js'),
  scanSelf: join(REPO_ROOT, 'test/audit-integrity-cross-store-scans.test.js'),
  /** V1.36 design/plan docs only — explicit allowlist, not recursive docs scan. */
  crossStoreSpec: join(
    REPO_ROOT,
    'docs/superpowers/specs/2026-07-18-audit-integrity-cross-store-verifier-design.md',
  ),
  crossStorePlan: join(
    REPO_ROOT,
    'docs/superpowers/plans/2026-07-18-audit-integrity-cross-store-verifier.md',
  ),
});

const CROSS_STORE_APIS = Object.freeze([
  'verifyAuditIntegrityAgainstEventStore',
  'AuditIntegrityCrossStoreError',
]);

const INSPECT_API = 'inspectAuditIntegrityJournalFile';

const GENERATION_ID = '0123456789abcdef0123456789abcdef';

const STRICT_EVENT = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.scan-xstore',
  method: 'POST',
  path: '/api/scan-xstore',
  outcome: 'success',
});

/**
 * Clause delimiters for honesty scans.
 * English period only when followed by whitespace (`\.(?=\s)`) so `T6d.3` stays intact.
 * Whole-line "Not …" must NOT cover a later positive clause after these splits.
 */
const HONESTY_CLAUSE_SPLIT_RE = /[;；。,，—]|--|\.(?=\s)/;

/**
 * Clause-level negative / BLOCKED context (checked on the phrase-bearing clause only).
 */
function clauseHasNegativeOrBlockedContext(clause) {
  return (
    /\bBLOCKED\b/i.test(clause)
    || /\bNo\b/.test(clause)
    || /\bNot\b/.test(clause)
    || /\bwithout\b/i.test(clause)
    || /\bmissing\b/i.test(clause)
    || /禁止|未|不是|不/.test(clause)
    || /\bdo not\b/i.test(clause)
    || /\bdoes not\b/i.test(clause)
    || /\bmust not\b/i.test(clause)
    || /\bnever\b/i.test(clause)
    || /\bnot\b/i.test(clause)
    || /partial only/i.test(clause)
    || /still-partial|still partial/i.test(clause)
  );
}

/**
 * JSDoc / markdown bullet continuation under a BLOCKED inventory header
 * (e.g. ` * - T6d.3 complete / M6d Exit`).
 */
function isBlockedInventoryBullet(line) {
  return /^\s*\*\s+-\s/.test(line) || /^\s*-\s+\S/.test(line);
}

function isBlankOrDecorativeStarLine(line) {
  return /^\s*\*?\s*$/.test(line);
}

/**
 * Strip optional leading JSDoc star so header shapes match prose and comments.
 * e.g. ` * BLOCKED:` → `BLOCKED:`
 */
function stripOptionalJsdocStarPrefix(line) {
  return String(line).replace(/^\s*\*\s?/, '').trim();
}

/**
 * Explicit BLOCKED inventory header only — opens inventory for *subsequent* bullets.
 * Pure `BLOCKED:` / bare `BLOCKED`, or `BLOCKED / not delivered (do not claim):`.
 * Same-line claims that put controlled phrases after BLOCKED are NOT headers
 * (those go through clause-local scan; e.g. `* BLOCKED: T6d.3 complete...`).
 */
function isBlockedInventoryHeader(line) {
  const body = stripOptionalJsdocStarPrefix(line);
  if (/^BLOCKED\s*:\s*$/i.test(body)) return true;
  if (/^BLOCKED\s*$/i.test(body)) return true;
  if (/^BLOCKED\s*\/\s*not delivered\b[^:]*:\s*$/i.test(body)) return true;
  return false;
}

/**
 * Returns offenders where `phrase` appears without BLOCKED/negative context.
 * Context is clause-local, plus a narrow multi-line BLOCKED inventory:
 * only an explicit header opens inventory for following `* - …` / `- …` bullets;
 * blank / non-bullet ends the inventory. Phrase-bearing lines with BLOCKED
 * are never whole-line skipped — they use clause-local context unless they are
 * inherited inventory bullets. Early "Not" never covers a later positive clause.
 * Pure — used by production scans and hostile canaries.
 */
function findUnqualifiedHonestyPhraseLines(text, phrase) {
  const offenders = [];
  const lines = String(text).split(/\r?\n/);
  let inBlockedInventory = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 1) Inherit only from inventory state *before* this line is processed.
    const isInheritedBullet = inBlockedInventory && isBlockedInventoryBullet(line);

    // 2) blank / non-bullet ends the previous inventory (bullets keep it open).
    if (inBlockedInventory) {
      if (isBlankOrDecorativeStarLine(line) || !isBlockedInventoryBullet(line)) {
        inBlockedInventory = false;
      }
    }

    // 3) Explicit header opens inventory for *subsequent* lines only.
    if (isBlockedInventoryHeader(line)) {
      inBlockedInventory = true;
    }

    if (!line.includes(phrase)) continue;

    // 4) Only true inherited bullets skip clause-local scan; never whole-line skip
    //    just because the current line contains BLOCKED.
    if (isInheritedBullet) continue;

    const clauses = line.split(HONESTY_CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (!clause.includes(phrase)) continue;
      if (!clauseHasNegativeOrBlockedContext(clause)) {
        offenders.push({ line: i + 1, clause, text: line });
      }
    }
  }
  return offenders;
}

function assertHonestyPhraseQualified(text, phrase, label) {
  const offenders = findUnqualifiedHonestyPhraseLines(text, phrase);
  assert.equal(
    offenders.length,
    0,
    `${label}: unqualified "${phrase}" at ${offenders.map((o) => `L${o.line}:{${o.clause}}`).join(' | ')}`,
  );
}

/**
 * Collect static import module specifiers from raw source (no comment stripping).
 * Recognizes multiline-anchored:
 *   import ... from 'x'
 *   import 'x'
 * Not blinded by `/\/\//` inside earlier regex literals. Does not collect dynamic import(.
 */
function collectStaticImportSpecifiers(raw) {
  const text = String(raw);
  const specs = [];
  const startRe = /^[ \t]*import\b/gm;
  let start;
  while ((start = startRe.exec(text)) !== null) {
    const afterKw = text.slice(start.index + start[0].length);
    // Dynamic import( — skip (not a static import statement).
    if (/^\s*\(/.test(afterKw)) continue;

    // Side-effect: import 'mod' / import "mod"
    const side = /^[ \t]*(['"])([^'"]+)\1/.exec(afterKw);
    if (side) {
      specs.push(side[2]);
      continue;
    }

    // import … from 'mod' (body may span lines; first from + string wins).
    const from = /^[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/.exec(afterKw);
    if (from) {
      specs.push(from[2]);
    }
  }
  return specs;
}

/**
 * Detect real call sites of a callee name. Ignores bare name mentions in comments
 * that are not followed by `(` (avoids false red from "no safeAppendText" prose).
 * @param {string} source
 * @param {string} name
 * @returns {boolean}
 */
function hasCallSite(source, name) {
  const re = new RegExp(`\\b${name}\\s*\\(`);
  return re.test(String(source));
}

/**
 * Detect queue-like code symbols (identifiers / property access / calls).
 * Does NOT treat English "no queue" documentation alone as a positive queue symbol:
 * requires an identifier-shaped hit (word-boundary queue used as code token).
 * Hostile canary below proves comment-only negation cannot fake pass when call exists.
 * @param {string} source
 * @returns {string[]}
 */
function findQueueCodeSymbols(source) {
  const text = String(source);
  const hits = [];
  // Identifiers that look like queue plumbing (not the English word in "no queue").
  const patterns = [
    /\bwriteQueue\b/,
    /\benqueue\b/i,
    /\bdequeue\b/i,
    /\bqueue\s*[:=(]/,
    /\bqueue\./,
    /\.queue\b/,
    /\bconst\s+queue\b/,
    /\blet\s+queue\b/,
    /\bvar\s+queue\b/,
    /\bfunction\s+queue\b/,
    /\basync\s+function\s+queue\b/,
  ];
  for (const re of patterns) {
    if (re.test(text)) hits.push(re.source);
  }
  return hits;
}

const HONESTY_PHRASES = Object.freeze([
  'T6d.3 complete',
  'production integration',
  'production detects',
  'automatic next generation',
  'M6d Exit',
]);

/** Forbidden compound assembled at runtime (never write full adjacent literal in this file). */
function forbiddenTamperEvidentNeedle() {
  return ['tamper', 'evident'].join('-');
}

async function readText(absPath) {
  return readFile(absPath, 'utf8');
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-xstore-scan-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

async function loadCrossStore() {
  return import('../src/audit-integrity-cross-store.js');
}

async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}

function assertPathFreeCrossStoreError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityCrossStoreError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  assert.ok(!('cause' in error) || error.cause === undefined);
  const stackFirst = String(error.stack || '').split('\n')[0] || '';
  const json = JSON.stringify(error);
  const surfaces = [error.message, json, stackFirst];
  for (const s of surfaces) {
    if (rootHint) assert.ok(!s.includes(rootHint), `leaks root in surface: ${s}`);
    assert.ok(!s.includes('ENOENT'), 'leaks ENOENT');
    assert.ok(!s.includes('EACCES'), 'leaks EACCES');
    assert.ok(!/\/var\/|\/tmp\/|\/Users\//.test(s), `path-like leak: ${s}`);
  }
}

// ── pure-function hostile canaries (no I/O) ──────────────────────────────

describe('C3 scan helpers: honesty clause-level hostile canaries', () => {
  it('positive delivery claim is caught; BLOCKED/negative passes; early Not does not cover later clause', () => {
    const positive = 'T6d.3 complete and ready for production integration';
    const blocked = '* BLOCKED: T6d.3 complete / production integration / production detects / M6d Exit';
    const negative = 'Not T6d.3 complete; without production integration';
    const autoPos = 'implements automatic next generation on bounds';
    const autoNeg = '- BLOCKED: new generation after chain-break / automatic next generation / recovery';
    const detectsPos = 'production detects dual-write failures automatically';
    const exitPos = 'M6d Exit criteria met for release';

    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'production integration').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'production integration').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'production detects').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'M6d Exit').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'production integration').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(autoPos, 'automatic next generation').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(autoNeg, 'automatic next generation').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(detectsPos, 'production detects').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(exitPos, 'M6d Exit').length, 1);

    // Early line-level Not / semicolon must not shelter a later positive clause.
    const notThenPositiveSemi =
      'Not production ready; T6d.3 complete and production integration delivered';
    const t6Semi = findUnqualifiedHonestyPhraseLines(notThenPositiveSemi, 'T6d.3 complete');
    const prodSemi = findUnqualifiedHonestyPhraseLines(notThenPositiveSemi, 'production integration');
    assert.equal(t6Semi.length, 1, 'semicolon-split: T6d.3 complete must be caught');
    assert.equal(prodSemi.length, 1, 'semicolon-split: production integration must be caught');
    assert.ok(t6Semi[0].clause.includes('T6d.3 complete'));
    assert.ok(prodSemi[0].clause.includes('production integration'));

    const notThenPositiveDot = 'Not production ready. T6d.3 complete';
    const t6Dot = findUnqualifiedHonestyPhraseLines(notThenPositiveDot, 'T6d.3 complete');
    assert.equal(t6Dot.length, 1, 'period+space split: T6d.3 complete must be caught');
    assert.ok(t6Dot[0].clause.includes('T6d.3 complete'));
    // Must not split inside version-like T6d.3
    assert.equal(t6Dot[0].clause.includes('T6d.3'), true);

    // Same shapes that should still pass (negation/BLOCKED on the phrase clause itself).
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Not T6d.3 complete; without production integration',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: T6d.3 complete / M6d Exit / production detects',
        'M6d Exit',
      ).length,
      0,
    );

    // Multi-line BLOCKED inventory: bullets under BLOCKED header are qualified;
    // a later non-bullet positive claim after the inventory ends must still be caught.
    const blockedInventory = [
      ' * BLOCKED / not delivered (do not claim):',
      ' * - T6d.3 complete / M6d Exit / production-hardening ready',
      ' * - production integration / production detects',
      ' * - automatic next generation / recovery',
      ' *',
      ' * Honest limitations:',
      ' * We claim T6d.3 complete in production.',
    ].join('\n');
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'M6d Exit').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'production integration').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'production detects').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'automatic next generation').length, 0);
    const postInventory = findUnqualifiedHonestyPhraseLines(blockedInventory, 'T6d.3 complete');
    assert.ok(postInventory[0].clause.includes('We claim T6d.3 complete'));

    // Same-line BLOCKED + resolved + positive clauses must NOT whole-line skip:
    // inventory state must not green a later positive claim on the same line.
    const blockedResolvedPositive =
      'BLOCKED issue resolved; T6d.3 complete and production integration delivered';
    const t6Resolved = findUnqualifiedHonestyPhraseLines(
      blockedResolvedPositive,
      'T6d.3 complete',
    );
    const prodResolved = findUnqualifiedHonestyPhraseLines(
      blockedResolvedPositive,
      'production integration',
    );
    assert.equal(t6Resolved.length, 1, 'BLOCKED+resolved same line: T6d.3 complete must be caught');
    assert.equal(
      prodResolved.length,
      1,
      'BLOCKED+resolved same line: production integration must be caught',
    );
    assert.ok(t6Resolved[0].clause.includes('T6d.3 complete'));
    assert.ok(prodResolved[0].clause.includes('production integration'));

    // Single-line `* BLOCKED: phrase…` stays legal via clause-local BLOCKED (not inventory).
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: T6d.3 complete and production integration',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: T6d.3 complete and production integration',
        'production integration',
      ).length,
      0,
    );

    // Pure header then bullet inventory still qualifies; blank ends it.
    const pureHeaderInventory = [
      'BLOCKED:',
      '- T6d.3 complete',
      '',
      'T6d.3 complete delivered',
    ].join('\n');
    assert.equal(findUnqualifiedHonestyPhraseLines(pureHeaderInventory, 'T6d.3 complete').length, 1);
    const pureHeaderOffenders = findUnqualifiedHonestyPhraseLines(
      pureHeaderInventory,
      'T6d.3 complete',
    );
    assert.ok(pureHeaderOffenders[0].clause.includes('T6d.3 complete delivered'));
  });
});

describe('C3 scan helpers: raw static import extractor canaries', () => {
  it('collectStaticImportSpecifiers is not blinded by regex // and handles multiline', () => {
    // Handwritten comment strippers that treat // as line comments swallow the next import.
    const hostile = 'const r=/a\\/\\/b/;\nimport { readFile } from \'node:fs\';';
    assert.deepEqual(collectStaticImportSpecifiers(hostile), ['node:fs']);

    const multi = "import {\n  createHash,\n} from 'node:crypto';\nimport './side.js';";
    assert.deepEqual(collectStaticImportSpecifiers(multi), ['node:crypto', './side.js']);

    // Dynamic import( is not a static specifier.
    assert.deepEqual(collectStaticImportSpecifiers("const x = import('node:fs');"), []);

    // String/comment noise must not invent imports.
    const noise = "const s = \"import './audit-log.js'\";\n// import './fake.js'\nimport './real.js';";
    assert.deepEqual(collectStaticImportSpecifiers(noise), ['./real.js']);
  });
});

describe('C3 scan helpers: write-call / queue symbol canaries (no comment-only false green/red)', () => {
  it('hasCallSite ignores comment-only name; still detects real call after negation comment', () => {
    const commentOnly = '// no safeAppendText in this module\nconst x = 1;';
    assert.equal(hasCallSite(commentOnly, 'safeAppendText'), false);

    const realCall = '// no safeAppendText intended\nsafeAppendText(root, path, line);';
    assert.equal(hasCallSite(realCall, 'safeAppendText'), true);

    // English "no queue" alone is not a code symbol; writeQueue is.
    assert.equal(findQueueCodeSymbols('// Completely read-only: no queue, no write').length, 0);
    assert.ok(findQueueCodeSymbols('const writeQueue = [];').length >= 1);
    assert.ok(findQueueCodeSymbols('await queue.push(job)').length >= 1);
  });
});

// ── 1. cross-store import allowlist ──────────────────────────────────────

describe('C3 A: cross-store import allowlist (no audit-log)', () => {
  it('1. cross-store static imports are closed allowlist only; no audit-log', async () => {
    const raw = await readText(PATHS.crossStore);
    const imports = collectStaticImportSpecifiers(raw);
    const allowed = new Set([
      './safe-data-files.js',
      './audit-event-schema.js',
      './audit-integrity-journal.js',
      './error-codes.js',
    ]);
    assert.ok(imports.length >= 4, 'expected production imports');
    for (const spec of imports) {
      assert.ok(allowed.has(spec), `unexpected import: ${spec}`);
    }
    for (const need of allowed) {
      assert.ok(imports.includes(need), `missing required import: ${need}`);
    }
    // Explicit bans (including audit-log).
    for (const ban of [
      './audit-log.js',
      './server.js',
      './agent.js',
      './capability-audit-sink.js',
      './gold-readiness.js',
      'node:fs',
      'node:fs/promises',
    ]) {
      assert.equal(imports.includes(ban), false, `banned import present: ${ban}`);
    }
    assert.equal(raw.includes("from './audit-log.js'"), false);
    assert.equal(raw.includes('from "./audit-log.js"'), false);
    assert.equal(/\bimport\s*\(/.test(raw), false, 'cross-store must not use dynamic import(');
  });
});

// ── 2. journal isolation from cross-store / events writes ────────────────

describe('C3 B: journal has no cross-store and no events.jsonl business writes', () => {
  it('2. journal source has no cross-store module and no events.jsonl business write path', async () => {
    const full = await readText(PATHS.journal);
    assert.equal(full.includes('audit-integrity-cross-store'), false);
    assert.equal(full.includes('verifyAuditIntegrityAgainstEventStore'), false);
    // Business events store path must not appear in journal module.
    assert.equal(full.includes('events.jsonl'), false, 'journal must not mention events.jsonl');
    // No write of events path via relative path string used by audit-log.
    assert.equal(full.includes('audit/events.jsonl'), false);
  });
});

// ── 3. production surfaces have no cross-store wiring ────────────────────

describe('C3 C: production surfaces free of cross-store / inspect wiring', () => {
  it('3. audit-log/server/agent/capability-audit-sink have no cross-store module/API/inspect API', async () => {
    for (const label of ['auditLog', 'server', 'agent', 'capabilitySink']) {
      const full = await readText(PATHS[label]);
      assert.equal(
        full.includes('audit-integrity-cross-store'),
        false,
        `${label}: cross-store module`,
      );
      for (const api of CROSS_STORE_APIS) {
        assert.equal(full.includes(api), false, `${label}: ${api}`);
      }
      assert.equal(full.includes(INSPECT_API), false, `${label}: ${INSPECT_API}`);
    }
  });
});

// ── 4–6. BLOCKED / signature ceiling / forbidden compound / honesty ──────

describe('C3 D: signature ceiling, forbidden compound, honesty phrases', () => {
  it('4. cross-store source includes BLOCKED and signature ceiling keywords', async () => {
    const full = await readText(PATHS.crossStore);
    assert.ok(/\bBLOCKED\b/.test(full), 'must document BLOCKED');
    assert.ok(
      /[Ss]ignature ceiling/.test(full) || /Signature ceiling/.test(full),
      'must document signature ceiling',
    );
    assert.ok(
      full.includes(
        'V1.36 audit event/journal cross-store structural consistency verifier implementation',
      ),
      'must lock allowed completion claim',
    );
  });

  it('5. forbidden compound absent from cross-store source, scan suite, and V1.36 docs (runtime needle)', async () => {
    const needle = forbiddenTamperEvidentNeedle();
    // Prove needle is the intended compound without embedding adjacent full literal.
    assert.equal(needle, ['tamper', 'evident'].join('-'));
    assert.equal(needle.includes('-'), true);

    const full = await readText(PATHS.crossStore);
    assert.equal(full.includes(needle), false, 'cross-store must not contain forbidden compound');

    const self = await readText(PATHS.scanSelf);
    assert.equal(self.includes(needle), false, 'scan suite must not embed full forbidden compound');

    // V1.36 design + plan only (explicit PATHS; no recursive docs / README expansion).
    const spec = await readText(PATHS.crossStoreSpec);
    assert.equal(
      spec.includes(needle),
      false,
      'V1.36 design spec must not contain forbidden compound',
    );
    const plan = await readText(PATHS.crossStorePlan);
    assert.equal(
      plan.includes(needle),
      false,
      'V1.36 plan must not contain forbidden compound',
    );
  });

  it('6. honesty phrases only on negative/BLOCKED clauses; hostile early-Not canary is structural', async () => {
    const full = await readText(PATHS.crossStore);
    for (const phrase of HONESTY_PHRASES) {
      if (!full.includes(phrase)) continue;
      assertHonestyPhraseQualified(full, phrase, 'cross-store');
    }
    // Cross-store header is expected to list several BLOCKED phrases.
    assert.ok(full.includes('T6d.3 complete') || full.includes('production integration'));

    // Structural canary (pure): early Not must not cover a later positive clause.
    // This proves the same finder used above cannot be greened by a leading Not alone.
    const hostile =
      'Not delivered yet; T6d.3 complete and production detects automatic next generation; M6d Exit ready';
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'production detects').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'automatic next generation').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'M6d Exit').length, 1);
  });
});

// ── 7. path-free errors via public API ───────────────────────────────────

describe('C3 E: path-free cross-store errors via public API', () => {
  it('7. public API errors are path-free (broken + io-error); not regex-only', async () => {
    await withTempRoot('path-free', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      const {
        verifyAuditIntegrityAgainstEventStore,
        AuditIntegrityCrossStoreError,
      } = await loadCrossStore();

      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: { ...STRICT_EVENT },
      });
      // Mismatch → broken
      await mkdir(join(root, 'audit'), { recursive: true });
      const { stringifyStrictCanonicalSanitizedEvent } = await import(
        '../src/audit-event-schema.js'
      );
      const mutated = {
        ...STRICT_EVENT,
        path: '/api/scan-xstore-mutated',
      };
      await writeFile(
        eventsAbs(root),
        `${stringifyStrictCanonicalSanitizedEvent(mutated)}\n`,
        { mode: 0o600 },
      );

      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(root),
        (error) => {
          assert.ok(error instanceof AuditIntegrityCrossStoreError);
          assertPathFreeCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
            root,
          );
          return true;
        },
      );

      // Invalid root → io-error, path-free.
      // Unique child under this withTempRoot — never a global fixed tmpdir path.
      const badRoot = join(root, 'definitely-absent-child');
      await assert.rejects(
        () => lstat(badRoot),
        (err) => {
          assert.equal(err && err.code, 'ENOENT');
          return true;
        },
      );
      await assert.rejects(
        () => verifyAuditIntegrityAgainstEventStore(badRoot),
        (error) => {
          assert.ok(error instanceof AuditIntegrityCrossStoreError);
          assertPathFreeCrossStoreError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
            badRoot,
          );
          return true;
        },
      );

      // Constructed error surface also path-free.
      const constructed = new AuditIntegrityCrossStoreError(
        ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
      );
      assert.equal(constructed.message, constructed.code);
      assert.ok(!constructed.message.includes(root));
      assert.ok(!constructed.message.includes(journalAbs(root)));
      assert.ok(!constructed.message.includes(eventsAbs(root)));
    });
  });
});

// ── 8. no write APIs / no queue symbols ──────────────────────────────────

describe('C3 F: cross-store is read-only (no write APIs, no queue symbols)', () => {
  it('8. no safeAppend/Atomic/CreateExclusive call sites; no queue code symbols', async () => {
    const full = await readText(PATHS.crossStore);

    // Call-site detection (not comment-word presence): avoids false red from "no X" prose
    // and false green when a call exists after a negation comment (see helper canaries).
    assert.equal(hasCallSite(full, 'safeAppendText'), false);
    assert.equal(hasCallSite(full, 'safeAtomicWriteText'), false);
    assert.equal(hasCallSite(full, 'safeCreateExclusiveText'), false);

    // Stronger: names must not appear as import/call identifiers at all in this module.
    assert.equal(full.includes('safeAppendText'), false);
    assert.equal(full.includes('safeAtomicWriteText'), false);
    assert.equal(full.includes('safeCreateExclusiveText'), false);

    // Only safeReadText / assertSafeDataRoot from safe-data-files.
    assert.ok(full.includes('safeReadText'));
    assert.ok(full.includes('assertSafeDataRoot'));

    const queueHits = findQueueCodeSymbols(full);
    assert.deepEqual(queueHits, [], `unexpected queue code symbols: ${queueHits.join(', ')}`);

    // Documentation may say "no queue" — that is not a code symbol (canary locks this).
    assert.ok(/no queue/i.test(full), 'expected honest "no queue" documentation');
  });
});
