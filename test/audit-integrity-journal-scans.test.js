/**
 * C4 / Task7: isolation / sensitive / scope / honesty scans for audit integrity journal.
 * Reads only explicit file paths (import.meta.url → repo root). No git. No recursive secret dirs.
 * Forbidden capability compound is assembled at runtime so this file does not self-trip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';
import { sanitizeAuditEvent } from '../src/audit-event-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

/** Explicit allowlisted source/doc paths only — never recursive secret dirs. */
const PATHS = Object.freeze({
  journal: join(REPO_ROOT, 'src/audit-integrity-journal.js'),
  auditLog: join(REPO_ROOT, 'src/audit-log.js'),
  server: join(REPO_ROOT, 'src/server.js'),
  agent: join(REPO_ROOT, 'src/agent.js'),
  capabilitySink: join(REPO_ROOT, 'src/capability-audit-sink.js'),
  gold: join(REPO_ROOT, 'src/gold-readiness.js'),
  readme: join(REPO_ROOT, 'README.md'),
  scanSelf: join(REPO_ROOT, 'test/audit-integrity-journal-scans.test.js'),
});

const JOURNAL_APIS = Object.freeze([
  'initializeAuditIntegrityJournal',
  'appendAuditIntegrityEvent',
  'verifyAuditIntegrityJournalFile',
]);

const GENERATION_ID = '0123456789abcdef0123456789abcdef';

const STRICT_EVENT = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.scan-type-body',
  method: 'POST',
  path: '/api/scan-path-body',
  outcome: 'success',
  message: 'scan-message-body-unique',
});

const SECRET_PASSWORD = 'password-secret';
const SECRET_TOKEN = 'token-secret';

/**
 * Clause delimiters for honesty scans.
 * - `;` `；` `。` `,` `，` `—` `--`
 * - English period only when followed by whitespace (`\.(?=\s)`) so `T6d.3` stays intact.
 * Whole-line "Not …" must NOT cover a later positive clause after these splits.
 */
const HONESTY_CLAUSE_SPLIT_RE = /[;；。,，—]|--|\.(?=\s)/;

/**
 * Clause-level negative / BLOCKED context (checked on the phrase-bearing clause only).
 * Not a limited pre-window — full clause text is considered so leading `BLOCKED:` is kept.
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
  );
}

/**
 * Returns offenders where `phrase` appears in a clause that itself lacks BLOCKED/negative context.
 * Each offender keeps { line, clause, text } for diagnosis.
 * Pure — used by production scans and hostile canaries.
 */
function findUnqualifiedHonestyPhraseLines(text, phrase) {
  const offenders = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes(phrase)) continue;
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
 * Extract body of first append preflight branch:
 *   if (existingLines !== null && existingLines > AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES) { … }
 * Brace-balanced; pure helper for first-throw locking.
 */
function extractAppendExistingLinesBoundsBranchBody(source) {
  const condRe =
    /if\s*\(\s*existingLines\s*!==\s*null\s*&&\s*existingLines\s*>\s*AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES\s*\)\s*\{/;
  const m = condRe.exec(String(source));
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** First `throwJournalError(ERROR_CODES.X)` identifier inside branch body, or null. */
function firstThrowJournalErrorCodeIn(branchBody) {
  if (branchBody == null) return null;
  const m = /throwJournalError\s*\(\s*ERROR_CODES\.([A-Z0-9_]+)\s*\)/.exec(branchBody);
  return m ? m[1] : null;
}

/**
 * Assert bounds preflight branch's first throw is exactly AUDIT_INTEGRITY_BOUNDS_EXCEEDED
 * (no chain / other throwJournalError before it).
 */
function assertBoundsBranchFirstThrowIsBounds(source, label = 'append') {
  const body = extractAppendExistingLinesBoundsBranchBody(source);
  assert.ok(body != null, `${label}: missing existingLines>MAX bounds branch`);
  const throwIdx = body.search(/throwJournalError\s*\(/);
  assert.ok(throwIdx >= 0, `${label}: bounds branch has no throwJournalError`);
  const before = body.slice(0, throwIdx);
  assert.equal(/\bthrow\b/.test(before), false, `${label}: no throw before first throwJournalError`);
  const firstCode = firstThrowJournalErrorCodeIn(body);
  assert.equal(
    firstCode,
    'AUDIT_INTEGRITY_BOUNDS_EXCEEDED',
    `${label}: first throw must be AUDIT_INTEGRITY_BOUNDS_EXCEEDED, got ${firstCode}`,
  );
  return body;
}

const HONESTY_PHRASES = Object.freeze([
  'T6d.3 complete',
  'production integration',
  'automatic next generation',
]);

/** Forbidden compound assembled at runtime (never write full literal in this file). */
function forbiddenTamperEvidentNeedle() {
  return ['tamper-', 'evident'].join('');
}

async function readText(absPath) {
  return readFile(absPath, 'utf8');
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-aij-scan-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}

function assertPathFreeError(error, code, rootHint, secrets = []) {
  assert.equal(error.name, 'AuditIntegrityJournalError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  const stackFirst = String(error.stack || '').split('\n')[0] || '';
  const json = JSON.stringify(error);
  const surfaces = [error.message, json, stackFirst];
  for (const s of surfaces) {
    if (rootHint) assert.ok(!s.includes(rootHint), `leaks root in surface: ${s}`);
    assert.ok(!s.includes('ENOENT'), 'leaks ENOENT');
    assert.ok(!s.includes('EACCES'), 'leaks EACCES');
    assert.ok(!s.includes('EEXIST'), 'leaks EEXIST');
    for (const secret of secrets) {
      assert.ok(!s.includes(secret), `leaks secret ${secret}`);
    }
  }
}

// ── pure-function hostile canaries (no I/O) ──────────────────────────────

describe('C4 scan helpers: honesty clause-level hostile canaries', () => {
  it('positive delivery claim is caught; BLOCKED/negative clause passes; early Not does not cover later clause', () => {
    const positive = 'T6d.3 complete and ready for production integration';
    const blocked = '* BLOCKED: T6d.3 complete / production integration';
    const negative = 'Not T6d.3 complete; without production integration';
    const autoPos = 'implements automatic next generation on bounds';
    const autoNeg = '- BLOCKED: new generation after chain-break / automatic next generation / recovery';
    const listWithoutNegation = '- T6d.3 complete / production integration';

    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'production integration').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(listWithoutNegation, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'production integration').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'production integration').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(autoPos, 'automatic next generation').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(autoNeg, 'automatic next generation').length, 0);

    // Naive absence would wrongly fail BLOCKED documentation — prove we do not require absence.
    assert.ok(blocked.includes('T6d.3 complete'));
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'T6d.3 complete').length, 0);

    // Early line-level Not / period / semicolon must not shelter a later positive clause.
    const notThenPositiveSemi =
      'Not production ready; T6d.3 complete and production integration delivered';
    const t6Semi = findUnqualifiedHonestyPhraseLines(notThenPositiveSemi, 'T6d.3 complete');
    const prodSemi = findUnqualifiedHonestyPhraseLines(notThenPositiveSemi, 'production integration');
    assert.equal(t6Semi.length, 1, 'semicolon-split: T6d.3 complete must be caught');
    assert.equal(prodSemi.length, 1, 'semicolon-split: production integration must be caught');
    assert.ok(t6Semi[0].clause.includes('T6d.3 complete'));
    assert.ok(prodSemi[0].clause.includes('production integration'));
    assert.equal(t6Semi[0].line, 1);
    assert.equal(prodSemi[0].line, 1);

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
        'Not T6d.3 complete; without production integration',
        'production integration',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: T6d.3 complete / production integration',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: T6d.3 complete / production integration',
        'production integration',
      ).length,
      0,
    );
  });
});

describe('C4 scan helpers: bounds branch first-throw canaries', () => {
  it('only-bounds passes; chain-then-bounds and only-chain fail first-throw lock', () => {
    const onlyBounds = `
      if (existingLines !== null && existingLines > AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES) {
        throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
      }
    `;
    assert.doesNotThrow(() => assertBoundsBranchFirstThrowIsBounds(onlyBounds, 'only-bounds'));

    const chainThenBounds = `
      if (existingLines !== null && existingLines > AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES) {
        throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
        throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
      }
    `;
    assert.throws(
      () => assertBoundsBranchFirstThrowIsBounds(chainThenBounds, 'chain-then-bounds'),
      (err) => {
        assert.ok(err instanceof assert.AssertionError);
        assert.match(String(err.message), /AUDIT_CHAIN_BROKEN|first throw/);
        return true;
      },
    );

    const onlyChain = `
      if (existingLines !== null && existingLines > AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES) {
        throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
      }
    `;
    assert.throws(
      () => assertBoundsBranchFirstThrowIsBounds(onlyChain, 'only-chain'),
      (err) => {
        assert.ok(err instanceof assert.AssertionError);
        assert.match(String(err.message), /AUDIT_CHAIN_BROKEN|first throw/);
        return true;
      },
    );
  });
});

describe('C4 scan helpers: raw static import extractor canaries', () => {
  it('collectStaticImportSpecifiers is not blinded by regex // and handles multiline', () => {
    // Handwritten comment strippers that treat // as line comments swallow the next import.
    const hostile = 'const r=/a\\/\\/b/;\nimport { readFile } from \'node:fs\';';
    assert.deepEqual(collectStaticImportSpecifiers(hostile), ['node:fs']);

    const multi = "import {\n  createHash,\n} from 'node:crypto';\nimport './side.js';";
    assert.deepEqual(collectStaticImportSpecifiers(multi), ['node:crypto', './side.js']);

    // Dynamic import( is not a static specifier.
    assert.deepEqual(collectStaticImportSpecifiers("const x = import('node:fs');"), []);
  });
});

// ── A. zero production wiring ────────────────────────────────────────────

describe('C4 A: zero production journal wiring', () => {
  it('1. journal full raw text has no events.jsonl; bans audit-log import/API; requires schema import', async () => {
    const full = await readText(PATHS.journal);
    // Full raw text (plan: source text itself must not contain these tokens).
    assert.equal(full.includes('events.jsonl'), false, 'journal must not mention events.jsonl');
    assert.equal(full.includes("from './audit-log.js'"), false);
    assert.equal(full.includes('from "./audit-log.js"'), false);
    assert.equal(full.includes('appendAuditEvent'), false);
    assert.ok(
      full.includes("from './audit-event-schema.js'") || full.includes('from "./audit-event-schema.js"'),
      'journal must import audit-event-schema',
    );
  });

  it('2. audit-log raw text has no integrity-journal module or journal API names', async () => {
    const full = await readText(PATHS.auditLog);
    assert.equal(full.includes('audit-integrity-journal'), false);
    for (const api of JOURNAL_APIS) {
      assert.equal(full.includes(api), false, `audit-log must not reference ${api}`);
    }
  });

  it('3. server and agent raw text have no journal module or journal APIs', async () => {
    for (const label of ['server', 'agent']) {
      const full = await readText(PATHS[label]);
      assert.equal(full.includes('audit-integrity-journal'), false, `${label}: module name`);
      for (const api of JOURNAL_APIS) {
        assert.equal(full.includes(api), false, `${label}: ${api}`);
      }
    }
  });

  it('4. capability-audit-sink raw text has no integrity-journal or journal APIs', async () => {
    const full = await readText(PATHS.capabilitySink);
    assert.equal(full.includes('integrity-journal'), false);
    assert.equal(full.includes('audit-integrity-journal'), false);
    for (const api of JOURNAL_APIS) {
      assert.equal(full.includes(api), false, `sink: ${api}`);
    }
  });
});

// ── B. honest wording ────────────────────────────────────────────────────

describe('C4 B: honesty wording scans', () => {
  it('6. journal source includes missing trusted-recovery authorization model', async () => {
    const full = await readText(PATHS.journal);
    assert.ok(full.includes('missing trusted-recovery authorization model'));
  });

  it('7. journal names unkeyed structural foundation and no trusted anchor/HMAC/signature limitations', async () => {
    const full = await readText(PATHS.journal);
    const hasEn = full.includes('unkeyed hash-chain structural consistency foundation');
    const hasZh = full.includes('无密钥哈希链结构一致性基座');
    assert.ok(hasEn || hasZh, 'must include allowed capability name (EN or ZH)');
    assert.ok(full.includes('No external trusted anchor / HMAC / signature')
      || full.includes('no external trusted anchor')
      || /external trusted anchor\s*\/\s*HMAC\s*\/\s*signature/i.test(full));
    assert.ok(
      /honest limitation|Cannot detect|不能检测|no external anchor/i.test(full),
      'must document honest limitations',
    );
  });

  it('8. journal forbids tamper- + evident compound literal (needle assembled at runtime)', async () => {
    const full = await readText(PATHS.journal);
    const needle = forbiddenTamperEvidentNeedle();
    assert.equal(full.includes(needle), false, 'journal must not contain forbidden compound');
    // Self-scan: this test file must not embed the full compound either.
    const self = await readText(PATHS.scanSelf);
    assert.equal(self.includes(needle), false, 'scan suite must not embed full forbidden compound');
  });

  it('9. journal source has no WORM literal (no positive delivered claim)', async () => {
    const full = await readText(PATHS.journal);
    assert.equal(full.includes('WORM'), false);
  });

  it('10. honesty phrases in journal/gold/readme are only on BLOCKED/negative clauses', async () => {
    const texts = {
      journal: await readText(PATHS.journal),
      gold: await readText(PATHS.gold),
      readme: await readText(PATHS.readme),
    };
    for (const [label, text] of Object.entries(texts)) {
      for (const phrase of HONESTY_PHRASES) {
        if (!text.includes(phrase)) continue;
        assertHonestyPhraseQualified(text, phrase, label);
      }
    }
  });

  it('11. automatic next generation only on negative clauses; no next-generation/rotation exports', async () => {
    const full = await readText(PATHS.journal);
    if (full.includes('automatic next generation')) {
      assertHonestyPhraseQualified(full, 'automatic next generation', 'journal');
    }
    // Export absence on full raw text (no unreliable comment stripper).
    assert.equal(/export\s+(?:async\s+)?function\s+\w*(?:nextGeneration|NextGeneration|rotate|Rotate)\w*/.test(full), false);
    assert.equal(/export\s+\{[^}]*(?:nextGeneration|rotateJournal|rotateIntegrity)[^}]*\}/.test(full), false);
    assert.equal(full.includes('export async function rotate'), false);
  });
});

// ── C. bounds / error honesty (structural + runtime classification) ──────

describe('C4 C: bounds and error-code honesty', () => {
  it('12. source structure: append existingLines>MAX first throw is BOUNDS; 4097 is second evidence', async () => {
    const full = await readText(PATHS.journal);

    // At least one independent BOUNDS_EXCEEDED use site on raw source.
    const boundsUses = full.match(/ERROR_CODES\.AUDIT_INTEGRITY_BOUNDS_EXCEEDED/g) || [];
    assert.ok(boundsUses.length >= 1, 'must reference ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED in code');

    // Extract append function body (raw) for structural proof.
    const appendIdx = full.indexOf('export async function appendAuditIntegrityEvent');
    assert.ok(appendIdx >= 0, 'append export present');
    const verifyIdx = full.indexOf('export async function verifyAuditIntegrityJournalFile', appendIdx);
    const appendBody = full.slice(appendIdx, verifyIdx > appendIdx ? verifyIdx : appendIdx + 4000);

    // Lock: branch body first throwJournalError code is exactly BOUNDS_EXCEEDED (no prior chain/other throw).
    assertBoundsBranchFirstThrowIsBounds(appendBody, 'production append');

    // 4097 path remains second-layer evidence: MAX_LINES_AFTER_APPEND + bounds code (not chain-only mapping).
    assert.ok(
      full.includes('AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND')
        && full.includes('AUDIT_INTEGRITY_BOUNDS_EXCEEDED'),
      '4097/line-count ceiling must use bounds code path',
    );
  });

  it('13. IO_ERROR registry value differs from bounds; size oversize append → io not bounds', async () => {
    assert.notEqual(
      ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR,
      ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED,
    );
    assert.equal(ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR, 'audit-integrity-io-error');
    assert.equal(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED, 'audit-integrity-bounds-exceeded');

    await withTempRoot('size-io', async (root) => {
      const {
        appendAuditIntegrityEvent,
        AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
      } = await loadJournal();
      await mkdir(join(root, 'audit'), { recursive: true });
      const oversize = `${'x'.repeat(AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES + 1)}\n`;
      await writeFile(journalAbs(root), oversize, { mode: 0o600 });
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...STRICT_EVENT },
        }),
        (error) => {
          assertPathFreeError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR, root);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
          assert.notEqual(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          return true;
        },
      );
    });
  });
});

// ── D. sensitive / runtime scope ─────────────────────────────────────────

describe('C4 D: sensitive fields and path-free errors', () => {
  it('14. strict append with password/token extras → event-invalid; bytes unchanged; secrets absent', async () => {
    await withTempRoot('secret-reject', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const before = await readFile(journalAbs(root));
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: {
            ...STRICT_EVENT,
            password: SECRET_PASSWORD,
            token: SECRET_TOKEN,
          },
        }),
        (error) => {
          assertPathFreeError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID,
            root,
            [SECRET_PASSWORD, SECRET_TOKEN],
          );
          return true;
        },
      );
      const after = await readFile(journalAbs(root));
      assert.deepEqual(after, before);
      const text = after.toString('utf8');
      assert.ok(!text.includes(SECRET_PASSWORD));
      assert.ok(!text.includes(SECRET_TOKEN));
      assert.ok(!text.includes('password'));
      assert.ok(!text.includes('token'));
    });
  });

  it('15. sanitize secret raw then append succeeds; journal is digest-only without secrets or event body', async () => {
    await withTempRoot('secret-sanitize', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });

      const rawEvent = {
        type: STRICT_EVENT.type,
        method: STRICT_EVENT.method,
        path: STRICT_EVENT.path,
        outcome: STRICT_EVENT.outcome,
        message: STRICT_EVENT.message,
        password: SECRET_PASSWORD,
        token: SECRET_TOKEN,
      };
      const sanitized = sanitizeAuditEvent(rawEvent, new Date('2026-07-18T00:00:00.000Z'));
      // Sanitize drops non-allowlist keys.
      assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'password'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'token'), false);

      const receipt = await appendAuditIntegrityEvent(root, {
        generationId: GENERATION_ID,
        event: sanitized,
      });
      assert.equal(receipt.state, 'appended');

      const text = await readFile(journalAbs(root), 'utf8');
      assert.ok(!text.includes(SECRET_PASSWORD));
      assert.ok(!text.includes(SECRET_TOKEN));
      assert.ok(!text.includes('password'));
      assert.ok(!text.includes('token'));
      // Journal stores only digest records — not event raw type/path/message body.
      assert.ok(!text.includes(STRICT_EVENT.type));
      assert.ok(!text.includes(STRICT_EVENT.path));
      assert.ok(!text.includes(STRICT_EVENT.message));

      for (const line of text.trimEnd().split('\n')) {
        const rec = JSON.parse(line);
        assert.deepEqual(Object.keys(rec), [
          'schemaVersion',
          'recordKind',
          'generationId',
          'sequence',
          'previousLinkDigest',
          'payloadDigest',
          'linkDigest',
        ]);
      }
    });
  });

  it('16. invalid root and broken journal errors leak neither temp path, errno, nor secrets', async () => {
    await withTempRoot('err-surface', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
        verifyAuditIntegrityJournalFile,
      } = await loadJournal();

      await assert.rejects(
        () => initializeAuditIntegrityJournal(join(root, 'missing-not-a-root'), {
          generationId: GENERATION_ID,
        }),
        (error) => {
          assertPathFreeError(error, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR, root);
          return true;
        },
      );

      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), '{not-json\n', { mode: 0o600 });
      await assert.rejects(
        () => verifyAuditIntegrityJournalFile(root),
        (error) => {
          assertPathFreeError(
            error,
            ERROR_CODES.AUDIT_CHAIN_BROKEN,
            root,
            [SECRET_PASSWORD, SECRET_TOKEN],
          );
          return true;
        },
      );

      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: GENERATION_ID,
          event: { ...STRICT_EVENT, password: SECRET_PASSWORD },
        }),
        (error) => {
          // Strict event projection runs before journal read — exact event-invalid (no OR chain).
          assertPathFreeError(
            error,
            ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID,
            root,
            [SECRET_PASSWORD, SECRET_TOKEN],
          );
          return true;
        },
      );
    });
  });
});

// ── E. import closed set + scan self-scope ───────────────────────────────

describe('C4 E: import closed set and scan self-scope', () => {
  it('17. journal production imports are closed: crypto, safe-data-files, error-codes, audit-event-schema', async () => {
    const raw = await readText(PATHS.journal);
    // Closed set via raw static import extractor (not handwritten comment stripper).
    const imports = collectStaticImportSpecifiers(raw);
    const allowed = new Set([
      'node:crypto',
      './safe-data-files.js',
      './error-codes.js',
      './audit-event-schema.js',
    ]);
    assert.ok(imports.length >= 4, 'expected production imports');
    for (const spec of imports) {
      assert.ok(allowed.has(spec), `unexpected import: ${spec}`);
    }
    for (const need of allowed) {
      assert.ok(imports.includes(need), `missing required import: ${need}`);
    }
    // Explicit bans.
    for (const ban of [
      './server.js',
      './agent.js',
      './audit-log.js',
      './capability-audit-sink.js',
      './gold-readiness.js',
      'node:fs',
      'node:fs/promises',
    ]) {
      assert.equal(imports.includes(ban), false, `banned import present: ${ban}`);
    }
    // No dynamic import( in production journal raw (do not scan this test file).
    assert.equal(/\bimport\s*\(/.test(raw), false, 'journal must not use dynamic import(');
  });

  it('18. scan suite only reads explicit allowlisted paths; runtime roots stay under tmpdir', async () => {
    const self = await readText(PATHS.scanSelf);
    // Assemble sensitive path needles at runtime so this assertion block is not a self-hit.
    const bannedReadTargets = [
      ['.', 'env'].join(''),
      ['sec', 'rets', '/'].join(''),
      ['cred', 'entials', '/'].join(''),
      ['.', 'ssh', '/'].join(''),
      ['~/', '.', 'ssh'].join(''),
    ];
    for (const ban of bannedReadTargets) {
      assert.ok(!self.includes(ban), `scan must not target sensitive path fragment: ${ban}`);
    }
    // PATHS allowlist is explicit joins under REPO_ROOT — no recursive walk helpers.
    // Needles assembled (and identifier names avoid contiguous banned tokens).
    const dirListSyncNeedle = ['read', 'dir', 'Sync'].join('');
    const dirListCallNeedle = ['read', 'dir', '('].join('');
    assert.equal(self.includes(dirListSyncNeedle), false);
    assert.equal(self.includes(dirListCallNeedle), false);
    assert.ok(self.includes('import.meta.url'));

    // Explicit read targets used by this suite (path join segments only).
    for (const rel of [
      'src/audit-integrity-journal.js',
      'src/audit-log.js',
      'src/server.js',
      'src/agent.js',
      'src/capability-audit-sink.js',
      'src/gold-readiness.js',
      'README.md',
      'test/audit-integrity-journal-scans.test.js',
    ]) {
      assert.ok(self.includes(rel), `scan allowlist should name ${rel}`);
    }

    await withTempRoot('scope-tmp', async (root) => {
      assert.ok(root.startsWith(tmpdir()) || root.includes('/T/'));
      const { initializeAuditIntegrityJournal } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const abs = journalAbs(root);
      assert.ok(abs.startsWith(root));
      assert.ok(!abs.includes(['.', 'env'].join('')));
      assert.ok(!abs.includes(['.', 'ssh'].join('')));
    });
  });
});
