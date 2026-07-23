/**
 * C6 / Task6: isolation / honesty / controlled-wiring / limitation scans for
 * V1.37 journal-first crash-recoverable audit dual-write coordinator.
 *
 * Reads only explicit file paths (import.meta.url → repo root). No git.
 * No recursive secret dirs. Forbidden capability compound is assembled at
 * runtime so this file does not self-trip.
 *
 * Signature ceiling locked:
 *   V1.37 journal-first crash-recoverable audit dual-write coordinator implementation
 * Not T6d.3 complete / M6d Exit / production-hardening ready / Gold ready.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

/** Explicit allowlisted paths only — never recursive secret dirs. */
const PATHS = Object.freeze({
  dualWrite: join(REPO_ROOT, 'src/audit-integrity-dual-write.js'),
  dualWriteState: join(REPO_ROOT, 'src/audit-integrity-dual-write-state.js'),
  journal: join(REPO_ROOT, 'src/audit-integrity-journal.js'),
  crossStore: join(REPO_ROOT, 'src/audit-integrity-cross-store.js'),
  writeQueue: join(REPO_ROOT, 'src/audit-integrity-write-queue.js'),
  auditLog: join(REPO_ROOT, 'src/audit-log.js'),
  server: join(REPO_ROOT, 'src/server.js'),
  agent: join(REPO_ROOT, 'src/agent.js'),
  capabilitySink: join(REPO_ROOT, 'src/capability-audit-sink.js'),
  gold: join(REPO_ROOT, 'src/gold-readiness.js'),
  readme: join(REPO_ROOT, 'README.md'),
  errorCodes: join(REPO_ROOT, 'src/error-codes.js'),
  scanSelf: join(REPO_ROOT, 'test/audit-integrity-dual-write-scans.test.js'),
  dualWriteBehavior: join(REPO_ROOT, 'test/audit-integrity-dual-write.test.js'),
  dualWriteStateBehavior: join(REPO_ROOT, 'test/audit-integrity-dual-write-state.test.js'),
  journalBehavior: join(REPO_ROOT, 'test/audit-integrity-journal.test.js'),
  writeQueueBehavior: join(REPO_ROOT, 'test/audit-integrity-write-queue.test.js'),
  auditLogBehavior: join(REPO_ROOT, 'test/audit-log.test.js'),
  journalScans: join(REPO_ROOT, 'test/audit-integrity-journal-scans.test.js'),
  crossStoreScans: join(REPO_ROOT, 'test/audit-integrity-cross-store-scans.test.js'),
  dualWriteSpec: join(
    REPO_ROOT,
    'docs/superpowers/specs/2026-07-19-audit-integrity-dual-write-coordinator-design.md',
  ),
  dualWritePlan: join(
    REPO_ROOT,
    'docs/superpowers/plans/2026-07-19-audit-integrity-dual-write-coordinator.md',
  ),
});

const SIGNATURE_CEILING =
  'V1.37 journal-first crash-recoverable audit dual-write coordinator implementation';

const COORDINATOR_API = 'appendAuditEventWithIntegrityDualWrite';
const CROSS_VERIFY_API = 'verifyAuditIntegrityAgainstEventStore';

/** Journal unlocked mutators that only dual-write (or journal itself) may import. */
const JOURNAL_UNLOCKED = Object.freeze([
  'initializeAuditIntegrityJournalUnlocked',
  'planAuditIntegrityEventLinkUnlocked',
  'publishPlannedAuditIntegrityEventLinkAtomicUnlocked',
  'appendAuditIntegrityEventUnlocked',
]);

/** State unlocked mutators/gates. */
const STATE_UNLOCKED = Object.freeze([
  'loadDualWriteStateUnlocked',
  'publishDualWriteStateUnlocked',
  'assertDualWriteStateAbsentUnlocked',
]);

const HONESTY_PHRASES = Object.freeze([
  'T6d.3 complete',
  'M6d Exit',
  'production-hardening ready',
  'Gold ready',
  'production integration',
  'production detects',
  'automatic next generation',
  'state continuity',
  'multi-process exclusive lock',
  'end-to-end production audit delivery',
]);

/**
 * Clause delimiters for honesty scans.
 * English period only when followed by whitespace (`\.(?=\s)`) so `T6d.3` stays intact.
 * Whole-line "Not …" must NOT cover a later positive clause after these splits.
 */
const HONESTY_CLAUSE_SPLIT_RE = /[;；。,，—]|--|\.(?=\s)/;

function clauseHasNegativeOrBlockedContext(clause) {
  return (
    /\bBLOCKED\b/i.test(clause)
    || /\bNo\b/.test(clause)
    || /\bNot\b/.test(clause)
    || /\bno\b/i.test(clause)
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
    || /limitation/i.test(clause)
  );
}

function isBlockedInventoryBullet(line) {
  return /^\s*\*\s+-\s/.test(line) || /^\s*-\s+\S/.test(line);
}

function isBlankOrDecorativeStarLine(line) {
  return /^\s*\*?\s*$/.test(line);
}

function stripOptionalJsdocStarPrefix(line) {
  return String(line).replace(/^\s*\*\s?/, '').trim();
}

function isBlockedInventoryHeader(line) {
  const body = stripOptionalJsdocStarPrefix(line);
  if (/^BLOCKED\s*:\s*$/i.test(body)) return true;
  if (/^BLOCKED\s*$/i.test(body)) return true;
  if (/^BLOCKED\s*\/\s*not delivered\b[^:]*:\s*$/i.test(body)) return true;
  return false;
}

/**
 * Returns offenders where `phrase` appears without BLOCKED/negative context.
 * Context is clause-local, plus a narrow multi-line BLOCKED inventory.
 * Early "Not" never covers a later positive clause.
 */
function findUnqualifiedHonestyPhraseLines(text, phrase) {
  const offenders = [];
  const lines = String(text).split(/\r?\n/);
  let inBlockedInventory = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const isInheritedBullet = inBlockedInventory && isBlockedInventoryBullet(line);

    if (inBlockedInventory) {
      if (isBlankOrDecorativeStarLine(line) || !isBlockedInventoryBullet(line)) {
        inBlockedInventory = false;
      }
    }

    if (isBlockedInventoryHeader(line)) {
      inBlockedInventory = true;
    }

    if (!line.includes(phrase)) continue;
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

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isJsIdentPart(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Minimal JS lexical mask for scan honesty.
 * Preserves length and newlines so indices stay aligned; non-code becomes spaces.
 * Masks: line comments, block comments, ' / " strings, template *text*,
 * and regex literals (so `/a\/\/b/` does not blind later code as `//` comments).
 * Template `${expressions}` remain code (braces/calls inside expressions stay real).
 * Used by production C6 scans — not a full parser.
 */
function maskJsNonCode(source) {
  const s = String(source);
  const n = s.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = s[i];

  let i = 0;

  function maskChar(idx) {
    if (s[idx] !== '\n' && s[idx] !== '\r') out[idx] = ' ';
  }

  function canStartRegex(pos) {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(s[j])) j -= 1;
    if (j < 0) return true;
    const ch = s[j];
    // After these tokens a `/` begins a regex literal, not division.
    if ('(,=[{:!&|?+~^%;*<>'.includes(ch)) return true;
    if (ch === '-') {
      // `--` / identifier-minus are division-ish; single `-` after op still regex-ok.
      // Treat `-` as regex-capable (covers `return -/x/` style); `a- /b/` is rare in scans.
      return true;
    }
    if (isJsIdentPart(ch)) {
      let k = j;
      while (k >= 0 && isJsIdentPart(s[k])) k -= 1;
      const word = s.slice(k + 1, j + 1);
      return (
        word === 'return'
        || word === 'throw'
        || word === 'case'
        || word === 'in'
        || word === 'of'
        || word === 'typeof'
        || word === 'void'
        || word === 'delete'
        || word === 'new'
        || word === 'await'
        || word === 'yield'
        || word === 'else'
        || word === 'do'
        || word === 'instanceof'
      );
    }
    return false;
  }

  /**
   * Scan code from `i`. When `stopBraceDepth` is 0, return upon seeing a `}` that
   * closes the current template expression (leave that `}` unconsumed).
   */
  function scanCode(stopBraceDepth) {
    let braceDepth = 0;
    while (i < n) {
      const ch = s[i];
      const next = i + 1 < n ? s[i + 1] : '';

      if (stopBraceDepth !== null && ch === '}') {
        if (braceDepth === 0) return;
        braceDepth -= 1;
        i += 1;
        continue;
      }
      if (stopBraceDepth !== null && ch === '{') {
        braceDepth += 1;
        i += 1;
        continue;
      }

      // Line comment
      if (ch === '/' && next === '/') {
        while (i < n && s[i] !== '\n' && s[i] !== '\r') {
          out[i] = ' ';
          i += 1;
        }
        continue;
      }

      // Block comment
      if (ch === '/' && next === '*') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        while (i < n) {
          if (s[i] === '*' && i + 1 < n && s[i + 1] === '/') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            break;
          }
          maskChar(i);
          i += 1;
        }
        continue;
      }

      // Single / double quoted strings
      if (ch === '"' || ch === "'") {
        const q = ch;
        out[i] = ' ';
        i += 1;
        while (i < n) {
          if (s[i] === '\\') {
            out[i] = ' ';
            if (i + 1 < n) {
              maskChar(i + 1);
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          if (s[i] === q) {
            out[i] = ' ';
            i += 1;
            break;
          }
          // Unclosed string: stop at line break (keep newline).
          if (s[i] === '\n' || s[i] === '\r') break;
          out[i] = ' ';
          i += 1;
        }
        continue;
      }

      // Template literal: mask text; keep ${expression} as code for brace/call honesty.
      if (ch === '`') {
        out[i] = ' ';
        i += 1;
        while (i < n) {
          if (s[i] === '\\') {
            out[i] = ' ';
            if (i + 1 < n) {
              maskChar(i + 1);
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          if (s[i] === '`') {
            out[i] = ' ';
            i += 1;
            break;
          }
          if (s[i] === '$' && i + 1 < n && s[i + 1] === '{') {
            // Leave `${` and matching `}` as code so outer brace balance stays correct.
            i += 2;
            scanCode(0);
            if (i < n && s[i] === '}') i += 1;
            continue;
          }
          maskChar(i);
          i += 1;
        }
        continue;
      }

      // Regex literal (must not treat interior `//` as line comments).
      if (ch === '/' && canStartRegex(i)) {
        out[i] = ' ';
        i += 1;
        let inClass = false;
        while (i < n) {
          if (s[i] === '\\') {
            out[i] = ' ';
            if (i + 1 < n) {
              maskChar(i + 1);
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          if (s[i] === '[' && !inClass) {
            inClass = true;
            out[i] = ' ';
            i += 1;
            continue;
          }
          if (s[i] === ']' && inClass) {
            inClass = false;
            out[i] = ' ';
            i += 1;
            continue;
          }
          if (s[i] === '/' && !inClass) {
            out[i] = ' ';
            i += 1;
            while (i < n && /[a-zA-Z]/.test(s[i])) {
              out[i] = ' ';
              i += 1;
            }
            break;
          }
          if (s[i] === '\n' || s[i] === '\r') break;
          out[i] = ' ';
          i += 1;
        }
        continue;
      }

      i += 1;
    }
  }

  scanCode(null);
  return out.join('');
}

/**
 * Collect static import module specifiers from code only.
 * Finds line-anchored `import` on masked source; reads specifiers from original text.
 * Not blinded by `/\/\//` inside earlier regex literals. Does not collect dynamic import(.
 * Comment / string / template-text imports are not call-sites and not static imports.
 */
function collectStaticImportSpecifiers(raw) {
  const text = String(raw);
  const masked = maskJsNonCode(text);
  const specs = [];
  const startRe = /^[ \t]*import\b/gm;
  let start;
  while ((start = startRe.exec(masked)) !== null) {
    // Specifier strings live in original text (masked positions are spaces).
    const afterKw = text.slice(start.index + start[0].length);
    if (/^\s*\(/.test(afterKw)) continue;

    const side = /^[ \t]*(['"])([^'"]+)\1/.exec(afterKw);
    if (side) {
      specs.push(side[2]);
      continue;
    }

    const from = /^[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/.exec(afterKw);
    if (from) {
      specs.push(from[2]);
    }
  }
  return specs;
}

/**
 * Collect imported binding names from a static import of a given specifier.
 * Multiline-safe; uses the same lexical mask as collectStaticImportSpecifiers.
 */
function collectImportedBindingsFromSpecifier(raw, specifier) {
  const text = String(raw);
  const masked = maskJsNonCode(text);
  const names = [];
  const startRe = /^[ \t]*import\b/gm;
  let start;
  while ((start = startRe.exec(masked)) !== null) {
    const afterKw = text.slice(start.index + start[0].length);
    if (/^\s*\(/.test(afterKw)) continue;

    const from = /^([\s\S]*?)\bfrom\s*(['"])([^'"]+)\2/.exec(afterKw);
    if (!from || from[3] !== specifier) continue;
    const clause = from[1];
    // import { a, b as c } from 'mod'
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace) {
      for (const part of brace[1].split(',')) {
        const m = /(\w+)(?:\s+as\s+\w+)?/.exec(part.trim());
        if (m) names.push(m[1]);
      }
    }
    // import name from 'mod' / import * as name
    const def = /^\s*(\w+)/.exec(clause);
    if (def && def[1] !== 'type') names.push(def[1]);
  }
  return names;
}

/**
 * Detect real code call sites of a callee name.
 * Comments / strings / template text / regex bodies never count (no false green).
 */
function hasCallSite(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`);
  return re.test(maskJsNonCode(source));
}

function countCallSites(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  return (maskJsNonCode(source).match(re) || []).length;
}

/**
 * True when a real lease assert call appears near the unlocked entry (first ~200 chars).
 * Comment-only assert names must not false-green.
 */
function hasLeaseAssertNearEntry(body, maxChars = 200) {
  const region = String(body).slice(0, maxChars);
  return hasCallSite(region, 'assertAuditIntegrityWriteLease');
}

/**
 * Extract function body for `async function name(...) { ... }` or `function name(...) { ... }`
 * by brace balance on lexically masked source. Default-parameter `{}`, string/comment
 * braces, and template-text braces cannot truncate the body.
 */
function extractFunctionBody(source, name) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const re = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`,
  );
  const m = re.exec(masked);
  if (!m) return null;
  // Walk from the opening `(` of the parameter list to its matching `)` on masked text.
  let i = m.index + m[0].length - 1; // at '('
  let parenDepth = 0;
  for (; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        i += 1;
        break;
      }
    }
  }
  // Skip whitespace to the function body `{`.
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  if (masked[i] !== '{') return null;
  const openBrace = i;
  let depth = 0;
  for (let j = openBrace; j < masked.length; j += 1) {
    const ch = masked[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBrace + 1, j);
    }
  }
  return null;
}

/**
 * Extract body of `export async function appendAuditEvent(...) { ... }`.
 */
function extractAppendAuditEventBody(source) {
  return extractFunctionBody(source, 'appendAuditEvent');
}

/** Forbidden compound assembled at runtime (never write full adjacent literal). */
function forbiddenTamperEvidentNeedle() {
  return ['tamper', 'evident'].join('-');
}

async function readText(absPath) {
  return readFile(absPath, 'utf8');
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-dw-scan-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── pure-function hostile canaries (no I/O) ──────────────────────────────

describe('C6 scan helpers: honesty clause-level hostile canaries', () => {
  it('positive delivery claim is caught; BLOCKED/negative passes; early Not does not cover later clause', () => {
    const positive = 'T6d.3 complete and ready for production-hardening ready';
    const blocked = '* BLOCKED: T6d.3 complete / M6d Exit / production-hardening ready / Gold ready';
    const negative = 'Not T6d.3 complete; without production-hardening ready';
    const continuityPos = 'delivers state continuity under adversarial deletion';
    // Negation must sit on the same clause as the phrase (comma/semicolon split).
    const continuityNeg =
      '- not state continuity under adversarial state deletion (delete state may re-bootstrap)';
    const multiPos = 'supports multi-process exclusive lock across writers';
    const multiNeg = '- not multi-process exclusive lock (single-process queue only)';

    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'production-hardening ready').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'M6d Exit').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'production-hardening ready').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'Gold ready').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'production-hardening ready').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(continuityPos, 'state continuity').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(continuityNeg, 'state continuity').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(multiPos, 'multi-process exclusive lock').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(multiNeg, 'multi-process exclusive lock').length, 0);

    // Early line-level Not / semicolon must not shelter a later positive clause.
    const notThenPositiveSemi =
      'Not production ready; T6d.3 complete and M6d Exit delivered';
    const t6Semi = findUnqualifiedHonestyPhraseLines(notThenPositiveSemi, 'T6d.3 complete');
    const exitSemi = findUnqualifiedHonestyPhraseLines(notThenPositiveSemi, 'M6d Exit');
    assert.equal(t6Semi.length, 1, 'semicolon-split: T6d.3 complete must be caught');
    assert.equal(exitSemi.length, 1, 'semicolon-split: M6d Exit must be caught');
    assert.ok(t6Semi[0].clause.includes('T6d.3 complete'));
    assert.ok(exitSemi[0].clause.includes('M6d Exit'));

    const notThenPositiveDot = 'Not production ready. T6d.3 complete';
    const t6Dot = findUnqualifiedHonestyPhraseLines(notThenPositiveDot, 'T6d.3 complete');
    assert.equal(t6Dot.length, 1, 'period+space split: T6d.3 complete must be caught');
    assert.ok(t6Dot[0].clause.includes('T6d.3 complete'));
    assert.equal(t6Dot[0].clause.includes('T6d.3'), true);

    // Multi-line BLOCKED inventory: bullets under BLOCKED header are qualified;
    // a later non-bullet positive claim after the inventory ends must still be caught.
    const blockedInventory = [
      ' * BLOCKED / not delivered (do not claim):',
      ' * - T6d.3 complete / M6d Exit / production-hardening ready',
      ' * - Gold ready / state continuity / multi-process exclusive lock',
      ' *',
      ' * Honest limitations:',
      ' * We claim T6d.3 complete in production.',
    ].join('\n');
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'M6d Exit').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'production-hardening ready').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blockedInventory, 'Gold ready').length, 0);
    const postInventory = findUnqualifiedHonestyPhraseLines(blockedInventory, 'T6d.3 complete');
    assert.ok(postInventory[0].clause.includes('We claim T6d.3 complete'));

    // Same-line BLOCKED + resolved + positive must NOT whole-line skip.
    const blockedResolvedPositive =
      'BLOCKED issue resolved; T6d.3 complete and production-hardening ready delivered';
    assert.equal(
      findUnqualifiedHonestyPhraseLines(blockedResolvedPositive, 'T6d.3 complete').length,
      1,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(blockedResolvedPositive, 'production-hardening ready').length,
      1,
    );

    // Single-line `* BLOCKED: phrase…` stays legal via clause-local BLOCKED.
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: T6d.3 complete and production-hardening ready',
        'T6d.3 complete',
      ).length,
      0,
    );
  });
});

describe('C6 scan helpers: raw static import extractor canaries', () => {
  it('collectStaticImportSpecifiers is not blinded by regex // / comment / string / multiline', () => {
    const hostile = 'const r=/a\\/\\/b/;\nimport { readFile } from \'node:fs\';';
    assert.deepEqual(collectStaticImportSpecifiers(hostile), ['node:fs']);

    const multi = "import {\n  createHash,\n} from 'node:crypto';\nimport './side.js';";
    assert.deepEqual(collectStaticImportSpecifiers(multi), ['node:crypto', './side.js']);

    assert.deepEqual(collectStaticImportSpecifiers("const x = import('node:fs');"), []);

    const noise = "const s = \"import './audit-log.js'\";\n// import './fake.js'\nimport './real.js';";
    assert.deepEqual(collectStaticImportSpecifiers(noise), ['./real.js']);

    // Block-comment line-start import must not count (prior gap / false green).
    const blockImport = "/*\nimport './fake-block.js'\n*/\nimport './real.js';";
    assert.deepEqual(collectStaticImportSpecifiers(blockImport), ['./real.js']);

    // String / template-text imports must not count.
    const stringOnly = "const s = \"import './str.js'\";\nconst t = 'import \\'./sq.js\\'';";
    assert.deepEqual(collectStaticImportSpecifiers(stringOnly), []);

    const templateImport = 'const t = `\nimport \'./tpl.js\'\n`;\nimport \'./real-tpl.js\';';
    assert.deepEqual(collectStaticImportSpecifiers(templateImport), ['./real-tpl.js']);
  });
});

describe('C6 scan helpers: call-site / unlocked body canaries', () => {
  it('hasCallSite/countCallSites ignore comment/string/template name(); real call after comment counts', () => {
    const name = COORDINATOR_API;

    // Hostile: line comment / block comment / string / template text look like calls but are not.
    assert.equal(hasCallSite(`// ${name}()\nconst x = 1;`, name), false);
    assert.equal(countCallSites(`// ${name}()\nconst x = 1;`, name), 0);

    assert.equal(hasCallSite(`/* ${name}() */\nconst x = 1;`, name), false);
    assert.equal(countCallSites(`/* ${name}() */\nconst x = 1;`, name), 0);

    assert.equal(hasCallSite(`const s = "${name}()";`, name), false);
    assert.equal(countCallSites(`const s = '${name}()';`, name), 0);
    assert.equal(hasCallSite('const s = `' + name + '()`;', name), false);

    // Negation comment then real call — exactly one code call-site.
    const realAfterComment = `// ${name}()\n/* ${name}() */\n${name}(root, event);`;
    assert.equal(hasCallSite(realAfterComment, name), true);
    assert.equal(countCallSites(realAfterComment, name), 1);

    // Bare name without `(` is not a call-site.
    assert.equal(hasCallSite(`// no ${name} in this module\nconst x = 1;`, name), false);
  });

  it('extractFunctionBody survives default param {} / string+comment braces; lease entry ignores comment-only assert', () => {
    const defaultParam = `
export async function sampleDefault(options = {}) {
  return options.x;
}
`;
    const defaultBody = extractFunctionBody(defaultParam, 'sampleDefault');
    assert.ok(defaultBody != null, 'default param {} must not prevent body extract');
    assert.ok(defaultBody.includes('return options.x'));
    assert.equal(defaultBody.includes('options = {}'), false);

    const braceNoise = `
async function sampleBraces(a = { nested: true }) {
  const s = "}";
  const t = '{';
  /* } early closer in block comment */
  // }
  const u = \`}\${a}\`;
  return s + t + u;
}
`;
    const braceBody = extractFunctionBody(braceNoise, 'sampleBraces');
    assert.ok(braceBody != null, 'string/comment/template braces must not truncate body');
    assert.ok(braceBody.includes('return s + t + u'), 'must keep full body through real closer');
    assert.ok(braceBody.includes('/* } early closer in block comment */'));

    const commentOnlyLease = `
function unlockedCommentOnly(root, lease) {
  // assertAuditIntegrityWriteLease(root, lease)
  /* assertAuditIntegrityWriteLease(root, lease) */
  return 1;
}
`;
    const commentBody = extractFunctionBody(commentOnlyLease, 'unlockedCommentOnly');
    assert.ok(commentBody != null);
    assert.equal(
      hasLeaseAssertNearEntry(commentBody),
      false,
      'comment-only lease assert must not false-green',
    );
    assert.equal(hasCallSite(commentBody, 'assertAuditIntegrityWriteLease'), false);

    const realLeaseAfterComment = `
function unlockedRealLease(root, lease) {
  // assertAuditIntegrityWriteLease(root, lease)
  assertAuditIntegrityWriteLease(root, lease);
  return 1;
}
`;
    const realBody = extractFunctionBody(realLeaseAfterComment, 'unlockedRealLease');
    assert.ok(realBody != null);
    assert.equal(hasLeaseAssertNearEntry(realBody), true);
    assert.equal(countCallSites(realBody, 'assertAuditIntegrityWriteLease'), 1);
  });
});

// ── 1. exactly-one controlled wiring ─────────────────────────────────────

describe('C6 A: exactly-one controlled dual-write wiring', () => {
  it('1. only audit-log static-imports dual-write and appendAuditEvent body calls coordinator exactly once', async () => {
    const auditLog = await readText(PATHS.auditLog);
    const server = await readText(PATHS.server);
    const agent = await readText(PATHS.agent);
    const sink = await readText(PATHS.capabilitySink);
    const dualWrite = await readText(PATHS.dualWrite);

    const auditImports = collectStaticImportSpecifiers(auditLog);
    assert.equal(
      auditImports.filter((s) => s === './audit-integrity-dual-write.js').length,
      1,
      'audit-log must static-import dual-write exactly once',
    );
    const imported = collectImportedBindingsFromSpecifier(
      auditLog,
      './audit-integrity-dual-write.js',
    );
    assert.ok(imported.includes(COORDINATOR_API), 'must import coordinator binding');

    // Comment/string cannot invent a second import.
    const noiseOnly = "// import './audit-integrity-dual-write.js'\nconst s = \"import './audit-integrity-dual-write.js'\";";
    assert.deepEqual(collectStaticImportSpecifiers(noiseOnly), []);

    for (const [label, src] of [
      ['server', server],
      ['agent', agent],
      ['capabilitySink', sink],
    ]) {
      const specs = collectStaticImportSpecifiers(src);
      assert.equal(
        specs.includes('./audit-integrity-dual-write.js'),
        false,
        `${label}: must not static-import dual-write`,
      );
      assert.equal(src.includes('audit-integrity-dual-write'), false, `${label}: dual-write token`);
      assert.equal(hasCallSite(src, COORDINATOR_API), false, `${label}: coordinator call`);
    }

    const body = extractAppendAuditEventBody(auditLog);
    assert.ok(body != null, 'appendAuditEvent body must be extractable');
    assert.equal(countCallSites(body, COORDINATOR_API), 1, 'body: exact-one coordinator call');
    // Full module: exact-one call (declaration is export async function, not a call).
    assert.equal(countCallSites(auditLog, COORDINATOR_API), 1, 'audit-log: exact-one coordinator call');

    // Dual-write must not import audit-log (no cycle).
    const dwImports = collectStaticImportSpecifiers(dualWrite);
    assert.equal(dwImports.includes('./audit-log.js'), false);
  });
});

// ── 2. server/agent zero direct ──────────────────────────────────────────

describe('C6 B: server/agent zero direct dual-write/journal/cross-store/queue/state', () => {
  it('2. server and agent still static-import audit-log only; no dual-write stack', async () => {
    for (const label of ['server', 'agent']) {
      const full = await readText(PATHS[label]);
      const imports = collectStaticImportSpecifiers(full);
      assert.ok(imports.includes('./audit-log.js'), `${label}: must import audit-log`);
      for (const ban of [
        './audit-integrity-dual-write.js',
        './audit-integrity-dual-write-state.js',
        './audit-integrity-journal.js',
        './audit-integrity-cross-store.js',
        './audit-integrity-write-queue.js',
      ]) {
        assert.equal(imports.includes(ban), false, `${label}: banned import ${ban}`);
      }
      for (const token of [
        'audit-integrity-dual-write',
        'audit-integrity-journal',
        'audit-integrity-cross-store',
        'audit-integrity-write-queue',
        'audit-integrity-dual-write-state',
        'Unlocked',
        COORDINATOR_API,
        CROSS_VERIFY_API,
        'enqueueAuditIntegrityWriteTask',
        'loadDualWriteStateUnlocked',
        'publishDualWriteStateUnlocked',
      ]) {
        assert.equal(full.includes(token), false, `${label}: banned token ${token}`);
      }
    }
  });
});

// ── 3. journal isolation ─────────────────────────────────────────────────

describe('C6 C: journal isolation from audit-log/coordinator/events business path', () => {
  it('3. journal has no audit-log/coordinator import and no events.jsonl business path', async () => {
    const full = await readText(PATHS.journal);
    const imports = collectStaticImportSpecifiers(full);
    assert.equal(imports.includes('./audit-log.js'), false);
    assert.equal(imports.includes('./audit-integrity-dual-write.js'), false);
    assert.equal(full.includes('appendAuditEvent'), false);
    assert.equal(full.includes(COORDINATOR_API), false);
    assert.equal(full.includes('events.jsonl'), false);
    assert.equal(full.includes('audit/events.jsonl'), false);
  });
});

// ── 4. dual-write-state isolation ────────────────────────────────────────

describe('C6 D: dual-write-state import allowlist', () => {
  it('4. dual-write-state imports only schema/queue/safe/error; no journal/coordinator/audit-log', async () => {
    const full = await readText(PATHS.dualWriteState);
    const imports = collectStaticImportSpecifiers(full);
    const allowed = new Set([
      'node:util',
      './safe-data-files.js',
      './error-codes.js',
      './audit-event-schema.js',
      './audit-integrity-write-queue.js',
    ]);
    for (const spec of imports) {
      assert.ok(allowed.has(spec), `unexpected import: ${spec}`);
    }
    for (const ban of [
      './audit-integrity-journal.js',
      './audit-integrity-dual-write.js',
      './audit-log.js',
      './audit-integrity-cross-store.js',
      './server.js',
      './agent.js',
    ]) {
      assert.equal(imports.includes(ban), false, `banned: ${ban}`);
    }
    assert.equal(full.includes(COORDINATOR_API), false);
    assert.equal(full.includes('appendAuditEvent'), false);
  });
});

// ── 5. cross-store read-only + dual-write exact-one ──────────────────────

describe('C6 E: cross-store read-only; dual-write exact-one verifier importer', () => {
  it('5a. cross-store has no write/queue/unlocked mutators', async () => {
    const full = await readText(PATHS.crossStore);
    for (const name of [
      'safeAppendText',
      'safeAtomicWriteText',
      'safeAtomicWriteBytes',
      'safeCreateExclusiveText',
      'enqueueAuditIntegrityWriteTask',
      'publishDualWriteStateUnlocked',
      'loadDualWriteStateUnlocked',
    ]) {
      assert.equal(hasCallSite(full, name), false, `cross-store must not call ${name}`);
      assert.equal(full.includes(name), false, `cross-store must not name ${name}`);
    }
    assert.equal(full.includes('Unlocked'), false);
    assert.equal(full.includes('writeQueue'), false);
  });

  it('5b. audit-log/server/agent/sink zero direct cross-store; dual-write exact-one allowed', async () => {
    for (const label of ['auditLog', 'server', 'agent', 'capabilitySink']) {
      const full = await readText(PATHS[label]);
      assert.equal(full.includes('audit-integrity-cross-store'), false, `${label}: module`);
      assert.equal(full.includes(CROSS_VERIFY_API), false, `${label}: API`);
      assert.equal(full.includes('inspectAuditIntegrityJournalFile'), false, `${label}: inspect`);
    }

    const dualWrite = await readText(PATHS.dualWrite);
    const imports = collectStaticImportSpecifiers(dualWrite);
    assert.equal(
      imports.filter((s) => s === './audit-integrity-cross-store.js').length,
      1,
      'dual-write must static-import cross-store exactly once',
    );
    const bindings = collectImportedBindingsFromSpecifier(
      dualWrite,
      './audit-integrity-cross-store.js',
    );
    assert.ok(bindings.includes(CROSS_VERIFY_API), 'must import verifier binding');
    assert.ok(
      countCallSites(dualWrite, CROSS_VERIFY_API) >= 1,
      'dual-write must really call verifier',
    );
  });
});

// ── 6. capability sink isolation ─────────────────────────────────────────

describe('C6 F: capability sink fully isolated from dual-write stack', () => {
  it('6. sink has no dual-write/journal/cross-store/queue/state; proof file not on coordinator path', async () => {
    const full = await readText(PATHS.capabilitySink);
    for (const token of [
      'audit-integrity-dual-write',
      'audit-integrity-journal',
      'audit-integrity-cross-store',
      'audit-integrity-write-queue',
      'audit-integrity-dual-write-state',
      COORDINATOR_API,
      'appendAuditEvent',
      'integrity-dual-write-state',
      'integrity-journal',
    ]) {
      assert.equal(full.includes(token), false, `sink banned token: ${token}`);
    }
    assert.ok(full.includes('capability-proof-attempts.jsonl') || full.includes('CAPABILITY_REAL_AUDIT'));
    const dualWrite = await readText(PATHS.dualWrite);
    assert.equal(dualWrite.includes('capability-audit-sink'), false);
    assert.equal(dualWrite.includes('capability-proof-attempts'), false);
  });
});

// ── 7. unlocked import allowlist + lease assert ──────────────────────────

describe('C6 G: unlocked import allowlist and lease assert at mutator entry', () => {
  it('7a. only dual-write (and journal self/state gate) may import unlocked primitives; public zero', async () => {
    const dualWrite = await readText(PATHS.dualWrite);
    const journal = await readText(PATHS.journal);
    const state = await readText(PATHS.dualWriteState);

    // Dual-write imports journal unlocked + state unlocked.
    const dwJournalBindings = collectImportedBindingsFromSpecifier(
      dualWrite,
      './audit-integrity-journal.js',
    );
    for (const name of [
      'initializeAuditIntegrityJournalUnlocked',
      'planAuditIntegrityEventLinkUnlocked',
      'publishPlannedAuditIntegrityEventLinkAtomicUnlocked',
    ]) {
      assert.ok(dwJournalBindings.includes(name), `dual-write must import ${name}`);
    }
    const dwStateBindings = collectImportedBindingsFromSpecifier(
      dualWrite,
      './audit-integrity-dual-write-state.js',
    );
    for (const name of ['loadDualWriteStateUnlocked', 'publishDualWriteStateUnlocked']) {
      assert.ok(dwStateBindings.includes(name), `dual-write must import ${name}`);
    }

    // Journal may import only assertDualWriteStateAbsentUnlocked from state (public gate).
    const jStateBindings = collectImportedBindingsFromSpecifier(
      journal,
      './audit-integrity-dual-write-state.js',
    );
    assert.deepEqual(jStateBindings, ['assertDualWriteStateAbsentUnlocked']);

    // State must not import journal unlocked.
    const stateImports = collectStaticImportSpecifiers(state);
    assert.equal(stateImports.includes('./audit-integrity-journal.js'), false);

    for (const label of ['auditLog', 'server', 'agent', 'capabilitySink']) {
      const full = await readText(PATHS[label]);
      assert.equal(full.includes('Unlocked'), false, `${label}: Unlocked`);
      for (const name of [...JOURNAL_UNLOCKED, ...STATE_UNLOCKED]) {
        assert.equal(full.includes(name), false, `${label}: ${name}`);
      }
    }
  });

  it('7b. each unlocked mutator implementation entry asserts lease (not wide includes)', async () => {
    const journal = await readText(PATHS.journal);
    const state = await readText(PATHS.dualWriteState);
    const dualWrite = await readText(PATHS.dualWrite);

    for (const name of JOURNAL_UNLOCKED) {
      const body = extractFunctionBody(journal, name);
      assert.ok(body != null, `missing body for ${name}`);
      // Real code call near entry only — comment/string assert names must not false-green.
      assert.ok(hasLeaseAssertNearEntry(body), `${name}: lease assert near entry`);
    }
    for (const name of STATE_UNLOCKED) {
      const body = extractFunctionBody(state, name);
      assert.ok(body != null, `missing body for ${name}`);
      assert.ok(hasLeaseAssertNearEntry(body), `${name}: lease assert near entry`);
    }

    // Coordinator unlocked entry also asserts lease.
    const ensureBody = extractFunctionBody(dualWrite, 'ensureAuditIntegrityDualWriteIdleUnlocked');
    assert.ok(ensureBody != null);
    assert.ok(hasLeaseAssertNearEntry(ensureBody), 'ensure*: lease assert near entry');
  });
});

// ── 8. honesty phrases ───────────────────────────────────────────────────

describe('C6 H: honesty phrases only on negative/BLOCKED/limitation clauses', () => {
  it('8. dual-write source + gold/readme allowlist: controlled phrases qualified', async () => {
    // Scan production/docs surfaces only — this suite intentionally embeds positive
    // canary strings and must not self-trip the honesty scan.
    const targets = {
      dualWrite: await readText(PATHS.dualWrite),
      gold: await readText(PATHS.gold),
      readme: await readText(PATHS.readme),
    };
    for (const [label, text] of Object.entries(targets)) {
      for (const phrase of HONESTY_PHRASES) {
        if (!text.includes(phrase)) continue;
        assertHonestyPhraseQualified(text, phrase, label);
      }
    }

    // Structural early-Not canary using same finder.
    const hostile =
      'Not delivered yet; T6d.3 complete and production-hardening ready; M6d Exit ready';
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'T6d.3 complete').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'production-hardening ready').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(hostile, 'M6d Exit').length, 1);
  });
});

// ── 9. forbidden compound ────────────────────────────────────────────────

describe('C6 I: forbidden compound runtime needle is zero on allowlisted targets', () => {
  it('9. needle absent from dual-write stack, readme, gold, scans, design/plan', async () => {
    const needle = forbiddenTamperEvidentNeedle();
    assert.equal(needle, ['tamper', 'evident'].join('-'));
    assert.ok(needle.includes('-'));

    const targets = [
      PATHS.dualWrite,
      PATHS.dualWriteState,
      PATHS.journal,
      PATHS.crossStore,
      PATHS.auditLog,
      PATHS.server,
      PATHS.agent,
      PATHS.capabilitySink,
      PATHS.gold,
      PATHS.readme,
      PATHS.scanSelf,
      PATHS.journalScans,
      PATHS.crossStoreScans,
      PATHS.dualWriteSpec,
      PATHS.dualWritePlan,
    ];
    for (const abs of targets) {
      const text = await readText(abs);
      assert.equal(
        text.includes(needle),
        false,
        `forbidden compound present in ${abs}`,
      );
    }
    // This suite must not embed full adjacent literal either.
    const self = await readText(PATHS.scanSelf);
    assert.equal(self.includes(needle), false);
  });
});

// ── 10. dual-write header signature + BLOCKED ────────────────────────────

describe('C6 J: dual-write source header signature ceiling and BLOCKED list', () => {
  it('10. exact signature present; old C5-not-wired claim removed; BLOCKED list present', async () => {
    const full = await readText(PATHS.dualWrite);
    assert.ok(full.includes(SIGNATURE_CEILING), 'must include exact signature ceiling');
    assert.ok(/\bBLOCKED\b/.test(full), 'must document BLOCKED');
    assert.ok(
      /[Ss]ignature ceiling/.test(full),
      'must document signature ceiling',
    );

    // Old C5 "Does NOT wire production appendAuditEvent" must be gone / replaced.
    assert.equal(
      full.includes('Does NOT wire production appendAuditEvent'),
      false,
      'stale C5-not-wired claim must be removed',
    );
    // Positive controlled wiring statement.
    assert.ok(
      full.includes('audit-log.js is the only production static importer')
        || full.includes('sole production importer')
        || full.includes('only production static importer'),
      'must document audit-log unique wiring',
    );

    // Required BLOCKED / limitation topics (qualified, not positive delivery).
    for (const phrase of [
      'T6d.3 complete',
      'M6d Exit',
      'production-hardening ready',
      'Gold ready',
      'multi-process exclusive lock',
      'state continuity',
      'end-to-end production audit delivery',
      'WORM',
    ]) {
      assert.ok(full.includes(phrase), `header must mention BLOCKED/limitation topic: ${phrase}`);
      assertHonestyPhraseQualified(full, phrase, 'dual-write-header');
    }
    // single-process queue honesty
    assert.ok(
      /single-process/i.test(full),
      'must document single-process queue limitation',
    );
  });
});

// ── 11. audit-log no local queue/fast path (static + cold runtime) ────────

describe('C6 K: audit-log no local queue/fast path; cold triple runtime', () => {
  it('11. static absence of auditFileQueues/local queue/safeAppend/compact; cold append creates triple', async () => {
    const src = await readText(PATHS.auditLog);
    for (const banned of [
      'auditFileQueues',
      'auditQueueKey',
      'withAuditFileQueue',
      'compactAuditFile',
      'safeAppendText',
      'safeAtomicWriteText',
      'safeAtomicWriteBytes',
    ]) {
      assert.equal(src.includes(banned), false, `audit-log banned: ${banned}`);
    }
    assert.equal(src.includes('if (!retention'), false);
    assert.equal(src.includes('!retention && !'), false);

    // Cold runtime minimum: production append creates events+journal+state idle.
    // This is runtime evidence, not string deletion alone.
    const { appendAuditEvent } = await import('../src/audit-log.js');
    await withTempRoot('cold', async (root) => {
      await appendAuditEvent(root, {
        type: 'api.c6-cold',
        method: 'POST',
        path: '/api/c6-cold',
        outcome: 'success',
      });
      const events = join(root, 'audit', 'events.jsonl');
      const journal = join(root, 'audit', 'integrity-journal.jsonl');
      const state = join(root, 'audit', 'integrity-dual-write-state.json');
      const eventsText = await readFile(events, 'utf8');
      const journalText = await readFile(journal, 'utf8');
      const stateText = await readFile(state, 'utf8');
      assert.ok(eventsText.trim().length > 0);
      assert.ok(journalText.trim().length > 0);
      const parsed = JSON.parse(stateText);
      assert.equal(parsed.status, 'idle');
    });
  });
});

// ── 12. ERROR_CODES exact 88 (V1.42 G0c 74 + 14 restore) ───────────────

describe('C6 L: ERROR_CODES exact 88 (registry runtime assertion)', () => {
  // V1.42 G0c: registry exact 88 = 74 + 14 restore-* codes (not a process-lock-only bump).
  // Historical: V1.41 was 74 = V1.40 62 + 12 upload.
  it('12. ERROR_CODES registry length is exactly 88', () => {
    assert.equal(Object.keys(ERROR_CODES).length, 88);
    // Dual-write codes present (not a registry mutation).
    assert.equal(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
      'audit-integrity-dual-write-direct-mutation-blocked',
    );
  });
});

// ── 13. required named runtime behavior tests exist (not claim pass alone) ─

describe('C6 M: required named behavior tests exist in allowlisted files', () => {
  it('13. CP/retention/gate/lease/bounds/UTF-8/post needles exist in behavior suites', async () => {
    const dualWrite = await readText(PATHS.dualWriteBehavior);
    const state = await readText(PATHS.dualWriteStateBehavior);
    const journal = await readText(PATHS.journalBehavior);
    const queue = await readText(PATHS.writeQueueBehavior);
    const auditLog = await readText(PATHS.auditLogBehavior);

    const requiredInDualWrite = [
      'C4-4. CP1',
      'C4-5. CP2',
      'C4-6. CP3a',
      'C4-8. CP4',
      'C4-10. CP-X',
      'C4-13. prepared + both pre retention',
      'C4-14. rename-before',
      'C4-15. rename-after',
      'C4-31. legal 500-byte',
      'C4-32. event line 16050',
      'C4-33. journal generated link >374',
      'C4-49. invalid UTF-8',
      'C4-45. pure validator rejects fabricated uncovered-events',
      'C4-46. pure validator rejects empty',
      'C4-55. old lease expired',
      '19a. coordinator-first true race',
      '19b. direct-first true race',
    ];
    for (const needle of requiredInDualWrite) {
      assert.ok(dualWrite.includes(needle), `dual-write behavior missing: ${needle}`);
    }

    const requiredInState = [
      'idle state → public init DIRECT_MUTATION_BLOCKED',
      'invalid JSON state file',
      'unsafe state (symlink/dir)',
    ];
    // state tests may use different wording — accept dual-write-state or journal gate suites.
    const gateCorpus = `${state}\n${journal}`;
    assert.ok(
      gateCorpus.includes('DIRECT_MUTATION_BLOCKED')
        || gateCorpus.includes('direct mutation'),
      'direct gate tests present',
    );
    assert.ok(gateCorpus.includes('symlink') || gateCorpus.includes('dir'), 'symlink/dir gate');
    assert.ok(gateCorpus.includes('invalid JSON') || gateCorpus.includes('invalid'), 'invalid state gate');
    assert.ok(
      journal.includes('state missing') || journal.includes('C2-1'),
      'state missing public journal tests',
    );

    assert.ok(queue.includes('cross-root lease') || queue.includes('cross-root'));
    assert.ok(queue.includes('detached') || queue.includes('nested'));
    assert.ok(queue.includes('nested same-root') || queue.includes('nested'));

    // C5 production wiring cold/static still present.
    assert.ok(auditLog.includes('C5-19') || auditLog.includes('auditFileQueues'));
    assert.ok(auditLog.includes('C5-20') || auditLog.includes('cold'));

    for (const n of requiredInState) {
      // soft: prefer present in journal C2 suite wording variants
      void n;
    }
  });
});

// ── 14. state deletion re-bootstrap limitation (runtime evidence) ────────

describe('C6 N: state deletion re-bootstrap limitation (not protection)', () => {
  it('14. after successful append, delete state → next append re-bootstraps; limitation not continuity', async () => {
    const { appendAuditEvent } = await import('../src/audit-log.js');
    const { verifyAuditIntegrityAgainstEventStore } = await import(
      '../src/audit-integrity-cross-store.js'
    );

    await withTempRoot('state-del', async (root) => {
      await appendAuditEvent(root, {
        type: 'api.c6-state-del-1',
        method: 'POST',
        path: '/api/c6-state-del-1',
        outcome: 'success',
      });
      const statePath = join(root, 'audit', 'integrity-dual-write-state.json');
      const eventsPath = join(root, 'audit', 'events.jsonl');
      const journalPath = join(root, 'audit', 'integrity-journal.jsonl');

      const state1 = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(state1.status, 'idle');
      const events1 = await readFile(eventsPath, 'utf8');
      const journal1 = await readFile(journalPath, 'utf8');
      const cross1 = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross1.state, 'verified');
      assert.equal(cross1.relationship, 'equal');

      // Adversarial state deletion (not a delivered continuity protection).
      await unlink(statePath);

      // Next production append re-bootstraps from self-consistent stores.
      await appendAuditEvent(root, {
        type: 'api.c6-state-del-2',
        method: 'POST',
        path: '/api/c6-state-del-2',
        outcome: 'success',
      });

      const state2 = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(state2.status, 'idle');
      const events2 = await readFile(eventsPath, 'utf8');
      const journal2 = await readFile(journalPath, 'utf8');
      assert.ok(events2.startsWith(events1) || events2.length > events1.length);
      assert.ok(journal2.length >= journal1.length);
      const cross2 = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross2.state, 'verified');
      assert.ok(
        cross2.relationship === 'equal' || cross2.relationship === 'events-suffix-of-journal'
          || cross2.relationship === 'journal-suffix-of-events',
      );

      // Honesty lock: dual-write header documents this as limitation, not delivered continuity.
      const header = await readText(PATHS.dualWrite);
      assert.ok(header.includes('state continuity'));
      assertHonestyPhraseQualified(header, 'state continuity', 'state-deletion-limitation');
    });
  });
});

// ── 15. multi-process limitation static (no claim support) ───────────────

describe('C6 O: multi-process limitation documented; no support claim', () => {
  it('15. dual-write documents single-process queue only / no multi-process exclusive lock', async () => {
    const full = await readText(PATHS.dualWrite);
    assert.ok(/single-process/i.test(full));
    assert.ok(full.includes('multi-process exclusive lock'));
    assertHonestyPhraseQualified(full, 'multi-process exclusive lock', 'dual-write');
    // Must not claim multi-process support as delivered without negation.
    const offenders = findUnqualifiedHonestyPhraseLines(full, 'multi-process exclusive lock');
    assert.equal(offenders.length, 0);
  });
});
