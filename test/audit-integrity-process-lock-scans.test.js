/**
 * V1.40 C4 — process-lock scans / honesty / closed-set 62.
 *
 * Static gates for local multi-process write exclusive lock wiring:
 *   sole production importer = audit-integrity-write-queue.js
 *   real waitForLockf spawnImpl call bound: binary/argv/shell/env/fd
 *   mandatory post-exit-0 await assertLockFileAttributes + strict attr gates
 *   selected algorithm excludes hard-link / ORPHAN_GRACE / mkdir-owner reclaim
 *   queue lifecycle: await acquire → mint → task → finally delete → await release
 *   ERROR_CODES exact current closed-set; process-lock code unique
 *   honesty on truth surfaces: no unqualified network-FS auto fail-closed / T6d.3 …
 *
 * Scan roots: bounded under repo src/ (recursive .js), docs/ (explicit V1.40
 * plan/spec), test/ (self + coordinated closed-set suites). No git. No secrets.
 * Never package-lock. No production edits.
 *
 * Signature ceiling (docs/C4 only; this suite does not claim delivery):
 *   V1.40 local multi-process audit integrity write exclusive lock implementation
 * Not T6d.3 complete / M6d Exit / production-hardening ready / e2e delivered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(join(__dirname, '..'));
const SRC_DIR = join(REPO_ROOT, 'src');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const TEST_DIR = join(REPO_ROOT, 'test');

/**
 * Explicit scan targets under allowed roots (src / docs / test).
 * Labels only in diagnostics — never dump file contents or absolute paths.
 */
const PATHS = Object.freeze({
  processLock: join(SRC_DIR, 'audit-integrity-process-lock.js'),
  writeQueue: join(SRC_DIR, 'audit-integrity-write-queue.js'),
  errorCodes: join(SRC_DIR, 'error-codes.js'),
  gold: join(SRC_DIR, 'gold-readiness.js'),
  version: join(SRC_DIR, 'version.js'),
  readme: join(REPO_ROOT, 'README.md'),
  packageJson: join(REPO_ROOT, 'package.json'),
  v140Plan: join(
    DOCS_DIR,
    'superpowers/plans/2026-07-20-audit-multiprocess-write-lock.md',
  ),
  v140Spec: join(
    DOCS_DIR,
    'superpowers/specs/2026-07-20-audit-multiprocess-write-lock-design.md',
  ),
  errorCodesTest: join(TEST_DIR, 'error-codes.test.js'),
  admissionScans: join(TEST_DIR, 'server-write-admission-scans.test.js'),
  scanSelf: __filename,
});

const PROCESS_LOCK_MODULE = 'audit-integrity-process-lock.js';
const WRITE_QUEUE_MODULE = 'audit-integrity-write-queue.js';
const PROCESS_LOCK_SPEC = `./${PROCESS_LOCK_MODULE}`;

const ACQUIRE_API = 'acquireAuditIntegrityProcessLock';
const RELEASE_API = 'releaseAuditIntegrityProcessLock';
const ATTR_HELPER = 'assertLockFileAttributes';
const WAIT_LOCKF = 'waitForLockf';

const LOCKF_ABS = '/usr/bin/lockf';

/** Closed-set digit pairs assembled at runtime (no contiguous stale locks). */
function currentClosedSetCount() {
  return Number(['6', '2'].join(''));
}

function priorClosedSetCount() {
  return Number(['6', '1'].join(''));
}

function nextClosedSetCount() {
  return Number(['6', '3'].join(''));
}

function orphanGraceNeedle() {
  return ['ORPHAN', 'GRACE'].join('_');
}

function ownerJsonNeedle() {
  return ['owner', 'json'].join('.');
}

const HONESTY_PHRASES = Object.freeze([
  'T6d.3 complete',
  'M6d Exit',
  'production-hardening ready',
  'e2e delivered',
  'end-to-end production audit delivery',
  'network FS auto-detect',
  'network FS auto fail-closed',
  'network FS is auto-detected',
  'auto-detect network FS',
  'auto-reject network FS',
]);

const HONESTY_CLAUSE_SPLIT_RE = /[;；。,，—]|--|\.(?=\s)/;

function isNetworkFsPhrase(phrase) {
  return /network FS|auto-detect network|auto-reject network/i.test(phrase);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Phrase-local qualification only (P1-B).
 * NEVER: whole-clause any-BLOCKED; whole-line Out of scope shelter; arbitrary 否.
 * "PHRASE is not BLOCKED" / "Not X but PHRASE" / "Out of scope X; PHRASE" must fail.
 */
function phraseHasLocalNegation(clause, phrase) {
  const idx = clause.indexOf(phrase);
  if (idx < 0) return false;

  // Explicit anti-shelter: "PHRASE is not BLOCKED"
  if (new RegExp(
    `${escapeRegExp(phrase)}\\s+is\\s+not\\s+BLOCKED\\b`,
    'i',
  ).test(clause)) {
    return false;
  }

  const before = clause.slice(0, idx);
  const after = clause.slice(idx + phrase.length);
  const beforeWindow = before.slice(Math.max(0, before.length - 56));
  const afterWindow = after.slice(0, 40);
  const local = `${beforeWindow}${phrase}${afterWindow}`;

  // "not delivered" / still-partial adjacent to phrase
  if (
    /\b(not[\s-]+delivered|still-partial|still\s+partial|partial\s+only)\b/i.test(local)
  ) {
    return true;
  }

  // Network-FS: OUT OF CONTRACT / not detected family (same clause only)
  if (isNetworkFsPhrase(phrase)) {
    if (
      /OUT OF CONTRACT|out of contract|\bOOC\b/i.test(clause)
      || /not\s+detected|not\s+auto-reject|not\s+auto-detected|NOT\s+detect|does\s+NOT\s+detect|do\s+not\s+detect|no\s+promise\s+to\s+detect|MUST NOT claim|must not claim/i.test(
        clause,
      )
    ) {
      return true;
    }
  }

  // must not / do not claim … phrase
  if (/\b(must\s+not|do\s+not|does\s+not|never)\b[\s\w/-]{0,48}claim/i.test(beforeWindow)) {
    return true;
  }
  // P2: only tight "no false claim that PHRASE" or "no false "PHRASE" claim"
  // NOT generic "no false X and PHRASE"
  if (/\bno\s+false\s+claim\s+that\s*$/i.test(beforeWindow)) {
    return true;
  }
  if (
    /\bno\s+false\s*[“"']?\s*$/i.test(beforeWindow)
    && /^\s*[”"']?\s*claim\b/i.test(afterWindow)
  ) {
    return true;
  }

  // Immediate local no/not/never/without before phrase (limited filler).
  // Reject "Not X but PHRASE".
  const negRe = /\b(not|no|never|without)\b/gi;
  let negMatch;
  let lastNeg = null;
  while ((negMatch = negRe.exec(beforeWindow)) !== null) {
    lastNeg = negMatch;
  }
  if (lastNeg) {
    const between = beforeWindow.slice(lastNeg.index + lastNeg[0].length);
    if (/\bbut\b/i.test(between)) return false;
    if (/^[\s:：*._\-/·"“”']*$/.test(between)) return true;
    if (/^[\s:：*._\-/·"“”']*(claim\s+that\s+)?$/i.test(between)) return true;
    // "not T6d.3" style with tiny filler tokens only
    if (/^[\s:：*._\-/·"“”']{0,8}$/.test(between)) return true;
    // "does not complete PHRASE" / "not complete PHRASE" (gold nextStep prose)
    if (/^(?:\s+complete|\s+claim|\s+deliver)\s*$/i.test(between)) return true;
  }

  // Full-window patterns for multi-word negations ending at phrase
  if (/\bdoes\s+not\s+complete\s*$/i.test(beforeWindow)) return true;
  if (/\bnot\s+complete\s*$/i.test(beforeWindow)) return true;

  // Chinese local "不是" immediately before phrase
  if (/不是\s*$/.test(beforeWindow)) return true;

  // Slash/pipe inventory after leading "no"/"not" on same clause
  const inv = /\b(no|not)\b\s+(.+)$/i.exec(clause);
  if (inv && (inv[2].includes('/') || inv[2].includes('|'))) {
    const region = inv[2];
    if (region.includes(phrase) && !/\bbut\b/i.test(region.slice(0, region.indexOf(phrase)))) {
      if (region.split(/\s*[|/]\s*/).some((item) => item.includes(phrase))) return true;
    }
  }

  // Table cell: phrase cell then adjacent cell with 否 (not arbitrary 否 anywhere)
  // e.g. "| M6d Exit / Gold | **否** |"
  if (clause.includes('|') || before.includes('|') || after.includes('|')) {
    const cells = clause.split('|').map((c) => c.trim());
    for (let c = 0; c < cells.length; c += 1) {
      if (cells[c].includes(phrase)) {
        const next = cells[c + 1] || '';
        if (/否/.test(next) || /否/.test(cells[c].slice(cells[c].indexOf(phrase) + phrase.length))) {
          return true;
        }
      }
    }
  }

  return false;
}

function isBlankOrDecorativeStarLine(line) {
  return /^\s*\*?\s*$/.test(line);
}

function stripMarkdownLineDecor(line) {
  // Leading blockquote / list / bold markers for inventory header detection
  let s = String(line)
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .trim();
  // Strip wrapping **bold** and residual leading asterisks
  s = s.replace(/^\*+/, '').replace(/\*+$/, '').replace(/\*\*/g, '').trim();
  return s;
}

/**
 * Explicit inventory header only (line-start after markdown/blockquote strip).
 * Allowed: BLOCKED: | Not: | Out of scope: | FORBIDDEN as delivered: | 不是：
 */
function matchInventoryHeader(line) {
  const body = stripMarkdownLineDecor(line);
  // BLOCKED: or BLOCKED / not delivered:
  let m = /^(BLOCKED(?:\s*\/\s*not delivered[^:]*)?)\s*:\s*(.*)$/i.exec(body);
  if (m) return { kind: 'BLOCKED', rest: m[2] };
  m = /^(Not)\s*:\s*(.*)$/i.exec(body);
  if (m) return { kind: 'Not', rest: m[2] };
  m = /^(Out of scope)\s*[:：]\s*(.*)$/i.exec(body);
  if (m) return { kind: 'Out of scope', rest: m[2] };
  m = /^(FORBIDDEN as delivered)\s*:\s*(.*)$/i.exec(body);
  if (m) return { kind: 'FORBIDDEN', rest: m[2] };
  m = /^(不是)\s*[:：]\s*(.*)$/.exec(body);
  if (m) return { kind: '不是', rest: m[2] };
  return null;
}

/**
 * Inventory continuation only (P2):
 * - JSDoc `* - item` / `* | row`
 * - markdown `- item` / `+ item` / table `| row`
 * - real non-JSDoc indented continuation (design FORBIDDEN rows)
 * NOT plain JSDoc `* positive prose` (no dash).
 */
function isInventoryContinuationBullet(line) {
  if (isBlankOrDecorativeStarLine(line)) return false;
  if (/^```/.test(line.trim())) return false;
  if (matchInventoryHeader(line)) return false;
  // JSDoc explicit blocked inventory: "* - item" or "* | table"
  if (/^\s*\*\s+-\s+\S/.test(line)) return true;
  if (/^\s*\*\s+\|/.test(line)) return true;
  // Markdown dash/plus list (asterisk-only prose is NOT inventory)
  if (/^\s*[-+]\s+\S/.test(line)) return true;
  // Table row
  if (/^\s*\|/.test(line)) return true;
  // Indented non-JSDoc continuation (e.g. two-space design list body)
  if (/^\s{2,}[^*\s/]/.test(line)) return true;
  return false;
}

/**
 * Offenders: phrase without phrase-local negation or explicit inventory inheritance.
 * No whole-line Out of scope / FORBIDDEN / Not continue (P1-B).
 */
function findUnqualifiedHonestyPhraseLines(text, phrase) {
  const offenders = [];
  const lines = String(text).split(/\r?\n/);
  let inventoryRestActive = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = matchInventoryHeader(line);

    if (header) {
      inventoryRestActive = true;
      // Header line: rest after header is inventory (slash/semicolon lists) — qualified
      if (line.includes(phrase)) {
        // only rest region after header keyword qualifies; if phrase only in header token, still ok
        continue;
      }
      // Continue inheritance for following bullets even if this line had no phrase
      continue;
    }

    if (inventoryRestActive) {
      if (isInventoryContinuationBullet(line)) {
        // inherited inventory line — qualified
        if (line.includes(phrase)) continue;
        continue;
      }
      // blank decorative ends inventory
      if (isBlankOrDecorativeStarLine(line)) {
        inventoryRestActive = false;
      } else if (!/^\s/.test(line) && line.trim() !== '') {
        // non-indented structural line ends inventory
        inventoryRestActive = false;
      } else if (isInventoryContinuationBullet(line)) {
        // already handled
      } else {
        inventoryRestActive = false;
      }
    }

    // Re-check after possible inventory end on same line processing
    if (inventoryRestActive && isInventoryContinuationBullet(line)) continue;

    if (!line.includes(phrase)) continue;

    // If we just ended inventory above, fall through to clause scan
    if (matchInventoryHeader(line)) continue;

    const clauses = line.split(HONESTY_CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (!clause.includes(phrase)) continue;
      if (!phraseHasLocalNegation(clause, phrase)) {
        offenders.push({ line: i + 1, clause: clause.slice(0, 80) });
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
    `${label}: unqualified "${phrase}" at ${offenders.map((o) => `L${o.line}`).join(',')}`,
  );
}

function isJsIdentPart(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Minimal JS lexical mask. Preserves length/newlines; non-code → spaces.
 * Masks comments, strings, template text, regex; keeps ${expressions}.
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
    if ('(,=[{:!&|?+~^%;*<>'.includes(ch)) return true;
    if (ch === '-') return true;
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

      if (ch === '/' && next === '/') {
        while (i < n && s[i] !== '\n' && s[i] !== '\r') {
          out[i] = ' ';
          i += 1;
        }
        continue;
      }

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
          if (s[i] === '\n' || s[i] === '\r') break;
          out[i] = ' ';
          i += 1;
        }
        continue;
      }

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

function collectStaticImportSpecifiers(raw) {
  const text = String(raw);
  const masked = maskJsNonCode(text);
  const specs = [];
  const startRe = /^[ \t]*import\b/gm;
  let start;
  while ((start = startRe.exec(masked)) !== null) {
    const afterKw = text.slice(start.index + start[0].length);
    if (/^\s*\(/.test(afterKw)) continue;
    const side = /^[ \t]*(['"])([^'"]+)\1/.exec(afterKw);
    if (side) {
      specs.push(side[2]);
      continue;
    }
    const from = /^[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/.exec(afterKw);
    if (from) specs.push(from[2]);
  }
  return specs;
}

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
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace) {
      for (const part of brace[1].split(',')) {
        const m = /(\w+)(?:\s+as\s+\w+)?/.exec(part.trim());
        if (m) names.push(m[1]);
      }
    }
    const def = /^\s*(\w+)/.exec(clause);
    if (def && def[1] !== 'type') names.push(def[1]);
  }
  return names;
}

function countCallSites(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  return (maskJsNonCode(source).match(re) || []).length;
}

function firstMemberCallIndex(source, objectName, methodName) {
  const re = new RegExp(
    `\\b${escapeRegExp(objectName)}\\s*\\.\\s*${escapeRegExp(methodName)}\\s*\\(`,
  );
  const m = re.exec(maskJsNonCode(source));
  return m ? m.index : -1;
}

/** Extract function body by brace balance on masked source. */
function extractFunctionBody(source, name) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const re = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`,
  );
  const m = re.exec(masked);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
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
 * Split top-level call arguments using masked structure (paren/brace/bracket depth).
 * @param {string} source full source
 * @param {number} openParenIndex index of '('
 * @returns {{ args: string[], end: number } | null}
 */
function extractCallArguments(source, openParenIndex) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  if (masked[openParenIndex] !== '(') return null;
  const args = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let argStart = openParenIndex + 1;
  for (let i = openParenIndex; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') {
      depthParen += 1;
      continue;
    }
    if (ch === ')') {
      depthParen -= 1;
      if (depthParen === 0) {
        args.push(text.slice(argStart, i).trim());
        return { args, end: i };
      }
      continue;
    }
    if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (ch === ',' && depthParen === 1 && depthBrace === 0 && depthBracket === 0) {
      args.push(text.slice(argStart, i).trim());
      argStart = i + 1;
    }
  }
  return null;
}

/**
 * Find unique executable const/let/var binding for `name` and return RHS text.
 * Match binding keyword on masked source (comments/strings cannot invent bindings),
 * but do NOT let trailing `\\s*` swallow string-masked RHS spaces.
 * @returns {{ count: number, rhs: string | null, index: number }}
 */
function findExecutableBindingRhs(source, name) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  // Stop at `=` only — trailing spaces of masked string RHS must not be eaten.
  const re = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`,
    'g',
  );
  const hits = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    let start = m.index + m[0].length;
    // Skip horizontal whitespace only on original (not newlines — those end statement).
    while (start < text.length && (text[start] === ' ' || text[start] === '\t')) {
      start += 1;
    }
    hits.push(start);
  }
  if (hits.length === 0) return { count: 0, rhs: null, index: -1 };
  if (hits.length !== 1) return { count: hits.length, rhs: null, index: hits[0] };
  const start = hits[0];
  // RHS until semicolon or newline at depth 0 on masked structure.
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let end = start;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen -= 1;
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (
      (ch === ';' || ch === '\n')
      && depthParen === 0
      && depthBrace === 0
      && depthBracket === 0
    ) {
      end = i;
      break;
    }
    end = i + 1;
  }
  return { count: 1, rhs: text.slice(start, end).trim(), index: start };
}

/**
 * Strip line/block comments only; keep string literals (for exact argv freeze match).
 */
function stripJsCommentsKeepStrings(source) {
  const s = String(source);
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const ch = s[i];
    const next = i + 1 < n ? s[i + 1] : '';
    if (ch === '/' && next === '/') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      out.push(ch);
      i += 1;
      while (i < n) {
        out.push(s[i]);
        if (s[i] === '\\' && i + 1 < n) {
          out.push(s[i + 1]);
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** RHS must be exactly Object.freeze(['-s','-t','5','3']) after comment strip (P2). */
function isExactLockfArgvFreeze(rhs) {
  const stripped = stripJsCommentsKeepStrings(rhs).trim().replace(/;+\s*$/, '');
  return (
    /^Object\.freeze\s*\(\s*\[\s*['"]-s['"]\s*,\s*['"]-t['"]\s*,\s*['"]5['"]\s*,\s*['"]3['"]\s*\]\s*\)$/.test(
      stripped,
    )
  );
}

function isExactLockfBinaryLiteral(rhs) {
  const stripped = stripJsCommentsKeepStrings(rhs).trim().replace(/;+\s*$/, '');
  return new RegExp(`^['"]${escapeRegExp(LOCKF_ABS)}['"]$`).test(stripped);
}

/**
 * Parse options object: each of shell/env/stdio exactly once; no spread;
 * stdio exactly 4 elems; first 3 ignore; 4th = fd param. No loose fallback (P2).
 */
function analyzeSpawnOptionsObject(optsSrc, expectedFdIdent) {
  const text = String(optsSrc);
  const masked = maskJsNonCode(text);
  if (/\.\.\./.test(masked)) {
    return {
      shellFalse: false,
      envCreateNull: false,
      inheritsProcessEnv: true,
      fdOk: false,
      fdIdent: null,
      stdioFdForm: false,
      keyOnce: false,
    };
  }

  const shellKeys = (masked.match(/\bshell\s*:/g) || []).length;
  const envKeys = (masked.match(/\benv\s*:/g) || []).length;
  const stdioKeys = (masked.match(/\bstdio\s*:/g) || []).length;
  const keyOnce = shellKeys === 1 && envKeys === 1 && stdioKeys === 1;

  const shellFalse = keyOnce && /shell\s*:\s*false\b/.test(masked);
  const envCreateNull = keyOnce && /env\s*:\s*Object\.create\s*\(\s*null\s*\)/.test(masked);
  const inheritsProcessEnv =
    /env\s*:\s*process\.env\b/.test(masked)
    || (/\benv\s*:\s*\{/.test(masked) && !envCreateNull);

  // Locate stdio: [ ... ] with balanced brackets on masked
  let fdOk = false;
  let fdIdent = null;
  const stdioKey = /\bstdio\s*:\s*\[/.exec(masked);
  if (stdioKey && keyOnce) {
    const openBracket = stdioKey.index + stdioKey[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = openBracket; i < masked.length; i += 1) {
      if (masked[i] === '[') depth += 1;
      else if (masked[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close > openBracket) {
      const innerOrig = text.slice(openBracket + 1, close);
      const innerMasked = maskJsNonCode(innerOrig);
      // Split top-level commas
      const elems = [];
      let start = 0;
      let dPar = 0;
      let dBr = 0;
      let dBk = 0;
      for (let i = 0; i < innerMasked.length; i += 1) {
        const ch = innerMasked[i];
        if (ch === '(') dPar += 1;
        else if (ch === ')') dPar -= 1;
        else if (ch === '{') dBr += 1;
        else if (ch === '}') dBr -= 1;
        else if (ch === '[') dBk += 1;
        else if (ch === ']') dBk -= 1;
        else if (ch === ',' && dPar === 0 && dBr === 0 && dBk === 0) {
          elems.push(innerOrig.slice(start, i).trim());
          start = i + 1;
        }
      }
      elems.push(innerOrig.slice(start).trim());
      // Exactly 4 elements; no trailing fifth
      if (elems.length === 4) {
        const isIgnore = (e) => /^['"]ignore['"]$/.test(e.trim());
        if (isIgnore(elems[0]) && isIgnore(elems[1]) && isIgnore(elems[2])) {
          fdIdent = elems[3].trim();
          fdOk = fdIdent === expectedFdIdent;
        }
      }
    }
  }

  return {
    shellFalse,
    envCreateNull,
    inheritsProcessEnv,
    fdOk,
    fdIdent,
    stdioFdForm: fdOk,
    keyOnce,
  };
}

/**
 * P1-1/2 + P2: Bind spawn contract to unique real spawnImpl(...) inside waitForLockf.
 * Signature located on masked source only (comment signatures ignored).
 */
function analyzeLockfSpawnContract(source) {
  const full = String(source);
  const maskedFull = maskJsNonCode(full);
  const waitBody = extractFunctionBody(source, WAIT_LOCKF);
  if (waitBody == null) {
    return { ok: false, reason: 'missing-waitForLockf' };
  }

  // Signature from masked: real `function waitForLockf(` then balanced params
  const sigHead = new RegExp(
    `function\\s+${escapeRegExp(WAIT_LOCKF)}\\s*\\(`,
  ).exec(maskedFull);
  if (!sigHead) return { ok: false, reason: 'missing-wait-sig' };
  let sigOpen = sigHead.index + sigHead[0].length - 1;
  const sigArgs = extractCallArguments(full, sigOpen);
  if (!sigArgs || sigArgs.args.length < 2) {
    return { ok: false, reason: 'missing-wait-params' };
  }
  const spawnParam = sigArgs.args[0].trim().replace(/=.*$/, '').trim() || 'spawnImpl';
  const fdParam = sigArgs.args[1].trim().replace(/=.*$/, '').trim() || 'fd';

  // Unique real call to spawnParam( inside wait body
  const waitMasked = maskJsNonCode(waitBody);
  const callRe = new RegExp(`\\b${escapeRegExp(spawnParam)}\\s*\\(`, 'g');
  const callHits = [];
  let cm;
  while ((cm = callRe.exec(waitMasked)) !== null) {
    callHits.push(cm.index);
  }
  if (callHits.length !== 1) {
    return {
      ok: false,
      reason: 'spawn-call-count',
      spawnCallCount: callHits.length,
      binaryOk: false,
      argvExact: false,
      shellFalse: false,
      envCreateNull: false,
      inheritsProcessEnv: false,
      fdForm: false,
    };
  }

  let openParen = callHits[0];
  while (openParen < waitMasked.length && waitMasked[openParen] !== '(') openParen += 1;
  const extracted = extractCallArguments(waitBody, openParen);
  if (!extracted || extracted.args.length < 3) {
    return { ok: false, reason: 'spawn-args', spawnCallCount: 1 };
  }
  const [arg0, arg1, arg2] = extracted.args;

  let binaryOk = false;
  if (new RegExp(`^['"]${escapeRegExp(LOCKF_ABS)}['"]$`).test(arg0.trim())) {
    binaryOk = true;
  } else if (arg0.trim() === 'LOCKF_BINARY') {
    const bind = findExecutableBindingRhs(source, 'LOCKF_BINARY');
    binaryOk = bind.count === 1 && bind.rhs != null && isExactLockfBinaryLiteral(bind.rhs);
  }

  let argvExact = false;
  const arg1c = arg1.replace(/\s+/g, ' ').trim();
  if (
    arg1c === 'LOCKF_ARGV'
    || /^\[\s*\.\.\.\s*LOCKF_ARGV\s*\]$/.test(arg1c)
    || /^\[\s*\.\.\.LOCKF_ARGV\s*\]$/.test(arg1.replace(/\s+/g, ''))
  ) {
    const bind = findExecutableBindingRhs(source, 'LOCKF_ARGV');
    argvExact = bind.count === 1 && bind.rhs != null && isExactLockfArgvFreeze(bind.rhs);
  } else {
    argvExact = isExactLockfArgvFreeze(arg1);
  }

  const opts = analyzeSpawnOptionsObject(arg2, fdParam);

  const ok =
    binaryOk
    && argvExact
    && opts.shellFalse
    && opts.envCreateNull
    && !opts.inheritsProcessEnv
    && opts.stdioFdForm
    && opts.keyOnce
    && callHits.length === 1;

  return {
    ok,
    reason: ok ? 'ok' : 'contract',
    spawnCallCount: callHits.length,
    binaryOk,
    argvExact,
    shellFalse: opts.shellFalse,
    envCreateNull: opts.envCreateNull,
    inheritsProcessEnv: opts.inheritsProcessEnv,
    fdForm: opts.stdioFdForm,
    fdIdent: opts.fdIdent,
    fdParam,
    keyOnce: opts.keyOnce,
  };
}

/**
 * Collect body ranges of literal `if (false) { ... }` / `if (0) { ... }` (masked).
 * @returns {{ start: number, end: number }[]} inclusive body interior indices
 */
function collectLiteralFalseBranchRanges(masked) {
  const ranges = [];
  const re = /\bif\s*\(\s*(?:false|0)\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          // body interior (exclude braces)
          ranges.push({ start: open + 1, end: i - 1 });
          break;
        }
      }
    }
  }
  return ranges;
}

/** True when index lies inside a literal if(false)/if(0) brace body (any ancestor). */
function isInsideLiteralFalseBranch(masked, index) {
  if (index < 0) return true;
  for (const r of collectLiteralFalseBranchRanges(masked)) {
    if (index >= r.start && index <= r.end) return true;
  }
  return false;
}

/**
 * Try-block body ranges (top-level try keywords on masked source).
 * @returns {{ start: number, end: number }[]}
 */
function collectTryBodyRanges(masked) {
  const ranges = [];
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          ranges.push({ start: open + 1, end: i - 1 });
          break;
        }
      }
    }
  }
  return ranges;
}

/**
 * Brace depth at `index` relative to `bodyStart` (only { } between).
 * depth 0 = direct statement of that body.
 */
function relativeBraceDepth(masked, bodyStart, index) {
  if (index < bodyStart) return -1;
  let depth = 0;
  for (let i = bodyStart; i < index && i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') depth -= 1;
  }
  return depth;
}

/**
 * Post-exit-0: direct-block await pre + wait + post in same try (P1-2 4th GLM).
 * Exactly 2 direct await attr + 1 direct await waitForLockf; order pre < wait < post.
 * Outer try wrapping inner awaits does not count (depth>0 relative to outer).
 */
function analyzePostExit0Revalidation(source) {
  const acquireBody = extractFunctionBody(source, ACQUIRE_API);
  if (acquireBody == null) {
    return { ok: false, reason: 'missing-acquire-body' };
  }
  const masked = maskJsNonCode(acquireBody);

  const waitRe = new RegExp(`await\\s+${escapeRegExp(WAIT_LOCKF)}\\s*\\(`, 'g');
  const attrRe = new RegExp(`await\\s+${escapeRegExp(ATTR_HELPER)}\\s*\\(`, 'g');

  /** @type {number[]} */
  const waitAll = [];
  let wm;
  while ((wm = waitRe.exec(masked)) !== null) {
    if (!isInsideLiteralFalseBranch(masked, wm.index)) waitAll.push(wm.index);
  }
  /** @type {number[]} */
  const attrAll = [];
  let am;
  while ((am = attrRe.exec(masked)) !== null) {
    if (!isInsideLiteralFalseBranch(masked, am.index)) attrAll.push(am.index);
  }

  const tryRanges = collectTryBodyRanges(masked);
  let ok = false;
  let waitIdx = -1;
  let preCount = 0;
  let postCount = 0;

  for (const tr of tryRanges) {
    const waits = waitAll.filter(
      (i) => i >= tr.start && i <= tr.end && relativeBraceDepth(masked, tr.start, i) === 0,
    );
    const attrs = attrAll.filter(
      (i) => i >= tr.start && i <= tr.end && relativeBraceDepth(masked, tr.start, i) === 0,
    );
    // Exact direct counts: 1 wait, 2 attr
    if (waits.length !== 1 || attrs.length !== 2) continue;
    const w = waits[0];
    const sorted = [...attrs].sort((a, b) => a - b);
    if (sorted[0] < w && w < sorted[1]) {
      ok = true;
      waitIdx = w;
      preCount = 1;
      postCount = 1;
      break;
    }
  }

  return {
    ok,
    waitIdx,
    preCount,
    postCount,
    bareAttrCount: countCallSites(acquireBody, ATTR_HELPER),
    hasAwaitWait: waitIdx >= 0,
  };
}

/**
 * Extract if (cond) consequent pairs on code-only structure.
 * @returns {{ cond: string, consequent: string, condIndex: number }[]}
 */
function extractIfFailClosedPairs(source) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const pairs = [];
  const ifRe = /\bif\s*\(/g;
  let m;
  while ((m = ifRe.exec(masked)) !== null) {
    let open = m.index + m[0].length - 1;
    if (masked[open] !== '(') continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < masked.length; i += 1) {
      if (masked[i] === '(') depth += 1;
      else if (masked[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const cond = text.slice(open + 1, close);
    let j = close + 1;
    while (j < masked.length && /\s/.test(masked[j])) j += 1;
    let consequent = '';
    if (masked[j] === '{') {
      let d = 0;
      const start = j;
      for (let k = j; k < masked.length; k += 1) {
        if (masked[k] === '{') d += 1;
        else if (masked[k] === '}') {
          d -= 1;
          if (d === 0) {
            consequent = text.slice(start, k + 1);
            break;
          }
        }
      }
    } else {
      const start = j;
      let dPar = 0;
      let dBr = 0;
      for (let k = j; k < masked.length; k += 1) {
        if (masked[k] === '(') dPar += 1;
        else if (masked[k] === ')') dPar -= 1;
        else if (masked[k] === '{') dBr += 1;
        else if (masked[k] === '}') dBr -= 1;
        else if ((masked[k] === ';' || masked[k] === '\n') && dPar === 0 && dBr === 0) {
          consequent = text.slice(start, k + (masked[k] === ';' ? 1 : 0));
          break;
        }
      }
    }
    pairs.push({ cond, consequent, condIndex: m.index });
  }
  return pairs;
}

/** Consequent is only throwUnavailable() (optionally braced). */
function isThrowUnavailableOnly(consequent) {
  const masked = maskJsNonCode(consequent).replace(/\s+/g, ' ').trim();
  return (
    /^throwUnavailable\s*\(\s*\)\s*;?$/.test(masked)
    || /^\{\s*throwUnavailable\s*\(\s*\)\s*;?\s*\}$/.test(masked)
  );
}

/** Normalize if-condition: strip comments (keep strings), collapse whitespace. */
function normalizeGateCondition(cond) {
  return stripJsCommentsKeepStrings(cond).replace(/\s+/g, ' ').trim();
}

/**
 * Production-allowed exact gate condition shapes (whitespace-normalized).
 * Quotes for 'function' may be ' or ".
 */
const EXACT_GATE_CONDS = Object.freeze({
  regularFd:
    /^typeof fdStat\.isFile !== ['"]function['"] \|\| !fdStat\.isFile\(\)$/,
  regularPath:
    /^typeof pathStat\.isFile !== ['"]function['"] \|\| !pathStat\.isFile\(\)$/,
  // Also allow bare !isFile() alone if production-shaped dual form used separately — production uses typeof||!
  // Production uses combined typeof || !isFile — only that shape.
  devIno:
    /^fdStat\.dev !== pathStat\.dev \|\| fdStat\.ino !== pathStat\.ino$/,
  nlink:
    /^fdStat\.nlink !== 1 \|\| pathStat\.nlink !== 1$/,
  mode:
    /^\(fdStat\.mode & 0o777\) !== 0o600 \|\| \(pathStat\.mode & 0o777\) !== 0o600$/,
  geteuidTypeof:
    /^typeof runtime\.geteuid !== ['"]function['"]$/,
  uid:
    /^fdStat\.uid !== euid \|\| pathStat\.uid !== euid$/,
});

/**
 * Exact full-condition fail-closed if at attr-body direct block (depth 0) (P1-1 4th GLM).
 * No substring needles; no false&& / gate&&flag / nested if/try.
 */
function hasExactDirectFailClosedIf(attrBody, exactRe) {
  const bodyMasked = maskJsNonCode(attrBody);
  for (const p of extractIfFailClosedPairs(attrBody)) {
    if (isInsideLiteralFalseBranch(bodyMasked, p.condIndex)) continue;
    // Direct block of assertLockFileAttributes body only
    if (relativeBraceDepth(bodyMasked, 0, p.condIndex) !== 0) continue;
    if (!isThrowUnavailableOnly(p.consequent)) continue;
    const norm = normalizeGateCondition(p.cond);
    if (exactRe.test(norm)) return true;
  }
  return false;
}

/**
 * geteuid() in direct-block try with catch immediate throwUnavailable.
 */
function hasGeteuidTryCatchFailClosed(attrBody) {
  const text = String(attrBody);
  const masked = maskJsNonCode(text);
  const tryRe = /\btry\s*\{/g;
  let m;
  while ((m = tryRe.exec(masked)) !== null) {
    if (isInsideLiteralFalseBranch(masked, m.index)) continue;
    // Direct try of attr body
    if (relativeBraceDepth(masked, 0, m.index) !== 0) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let tryEnd = -1;
    for (let i = open; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          tryEnd = i;
          break;
        }
      }
    }
    if (tryEnd < 0) continue;
    const tryBody = text.slice(open + 1, tryEnd);
    // geteuid call as direct content of this try (not nested deeper beyond simple statements)
    if (!/runtime\s*\.\s*geteuid\s*\(/.test(maskJsNonCode(tryBody))) continue;
    let j = tryEnd + 1;
    while (j < masked.length && /\s/.test(masked[j])) j += 1;
    if (!/^catch\b/.test(masked.slice(j))) continue;
    j += 5;
    while (j < masked.length && /\s/.test(masked[j])) j += 1;
    if (masked[j] === '(') {
      let d = 0;
      for (; j < masked.length; j += 1) {
        if (masked[j] === '(') d += 1;
        else if (masked[j] === ')') {
          d -= 1;
          if (d === 0) {
            j += 1;
            break;
          }
        }
      }
      while (j < masked.length && /\s/.test(masked[j])) j += 1;
    }
    if (masked[j] !== '{') continue;
    let d2 = 0;
    const cStart = j;
    let cEnd = -1;
    for (let k = j; k < masked.length; k += 1) {
      if (masked[k] === '{') d2 += 1;
      else if (masked[k] === '}') {
        d2 -= 1;
        if (d2 === 0) {
          cEnd = k;
          break;
        }
      }
    }
    if (cEnd < 0) continue;
    const catchBody = text.slice(cStart, cEnd + 1);
    if (isThrowUnavailableOnly(catchBody)) return true;
  }
  return false;
}

/**
 * Attr gates: exact full conditions + direct-block if + throwUnavailable (P1-1).
 */
function analyzeAttrGates(source) {
  const attrBody = extractFunctionBody(source, ATTR_HELPER);
  if (attrBody == null) {
    return {
      ok: false,
      regularBoth: false,
      sameDev: false,
      sameIno: false,
      nlinkBoth: false,
      modeBoth: false,
      geteuidTypeofFailClosed: false,
      geteuidCall: false,
      uidBoth: false,
    };
  }

  const regularFd = hasExactDirectFailClosedIf(attrBody, EXACT_GATE_CONDS.regularFd);
  const regularPath = hasExactDirectFailClosedIf(attrBody, EXACT_GATE_CONDS.regularPath);
  const regularBoth = regularFd && regularPath;

  const devIno = hasExactDirectFailClosedIf(attrBody, EXACT_GATE_CONDS.devIno);
  const nlinkBoth = hasExactDirectFailClosedIf(attrBody, EXACT_GATE_CONDS.nlink);
  const modeBoth = hasExactDirectFailClosedIf(attrBody, EXACT_GATE_CONDS.mode);
  const geteuidTypeofFailClosed = hasExactDirectFailClosedIf(
    attrBody,
    EXACT_GATE_CONDS.geteuidTypeof,
  );
  const geteuidCall = hasGeteuidTryCatchFailClosed(attrBody);
  const uidBoth = hasExactDirectFailClosedIf(attrBody, EXACT_GATE_CONDS.uid);

  const ok =
    regularBoth
    && devIno
    && nlinkBoth
    && modeBoth
    && geteuidTypeofFailClosed
    && geteuidCall
    && uidBoth;

  return {
    ok,
    regularBoth,
    sameDev: devIno,
    sameIno: devIno,
    nlinkBoth,
    modeBoth,
    geteuidTypeofFailClosed,
    geteuidCall,
    uidBoth,
  };
}

/**
 * Forbidden selected algorithms (code-only).
 */
function analyzeForbiddenSelectedAlgorithms(source) {
  const masked = maskJsNonCode(source);
  const orphan = orphanGraceNeedle();
  const findings = [];

  if (new RegExp(`\\b${escapeRegExp(orphan)}(?:_MS)?\\b`).test(masked)) {
    findings.push('orphan-grace');
  }
  if (findCodeStringLiteral(source, ownerJsonNeedle())) {
    findings.push('owner-json');
  }
  if (/\bhard[_-]?link\b/i.test(masked)) findings.push('hard-link-word');
  if (/\bhardlink\b/i.test(masked)) findings.push('hardlink-word');
  if (/\bfs\.link\s*\(/.test(masked)) findings.push('fs-link');
  if (/\blinkSync\s*\(/.test(masked)) findings.push('linkSync');
  if (/\bprocessStartId\b/.test(masked) || /\bOWNER_MAX_BYTES\b/.test(masked)) {
    findings.push('mkdir-owner-markers');
  }
  if (/\bunlink\s*\(/.test(masked)) findings.push('unlink-call');
  if (/\brename\s*\(/.test(masked)) findings.push('rename-call');
  if (/\bchmod\s*\(/.test(masked)) findings.push('chmod-call');

  return { ok: findings.length === 0, findings };
}

function findCodeStringLiteral(source, content) {
  const patterns = [
    new RegExp(`'${escapeRegExp(content)}'`, 'g'),
    new RegExp(`"${escapeRegExp(content)}"`, 'g'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const lineStart = source.lastIndexOf('\n', m.index) + 1;
      const prefix = source.slice(lineStart, m.index);
      if (/\/\//.test(prefix)) continue;
      const before = source.slice(0, m.index);
      if (before.lastIndexOf('/*') > before.lastIndexOf('*/')) continue;
      return true;
    }
  }
  return false;
}

/**
 * Extract body of previous...then(async () => { ... }) inside enqueue.
 */
function extractFifoThenAsyncBody(enqueueBody) {
  const text = String(enqueueBody);
  const masked = maskJsNonCode(text);
  // previous.catch(...).then(async () => {
  const re = /\.then\s*\(\s*async\s*\(\s*\)\s*=>\s*\{/;
  const m = re.exec(masked);
  if (!m) return null;
  const openBrace = m.index + m[0].length - 1;
  if (masked[openBrace] !== '{') return null;
  let depth = 0;
  for (let j = openBrace; j < masked.length; j += 1) {
    if (masked[j] === '{') depth += 1;
    else if (masked[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBrace + 1, j);
    }
  }
  return null;
}

/**
 * Extract try { body } finally { body } pairs (lexical mask + balanced braces).
 * @returns {Array<{
 *   tryIndex: number,
 *   tryBodyStart: number,
 *   tryBodyEnd: number,
 *   finallyBodyStart: number,
 *   finallyBodyEnd: number,
 *   tryBody: string,
 *   finallyBody: string,
 * }>}
 */
function extractTryFinallyPairs(source) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const pairs = [];
  const tryRe = /\btry\s*\{/g;
  let m;
  while ((m = tryRe.exec(masked)) !== null) {
    const tryOpen = m.index + m[0].length - 1;
    let depth = 0;
    let tryClose = -1;
    for (let i = tryOpen; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          tryClose = i;
          break;
        }
      }
    }
    if (tryClose < 0) continue;
    let j = tryClose + 1;
    while (j < masked.length && /\s/.test(masked[j])) j += 1;
    if (!/^finally\b/.test(masked.slice(j))) continue;
    j += 'finally'.length;
    while (j < masked.length && /\s/.test(masked[j])) j += 1;
    if (masked[j] !== '{') continue;
    const finOpen = j;
    depth = 0;
    let finClose = -1;
    for (let i = finOpen; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          finClose = i;
          break;
        }
      }
    }
    if (finClose < 0) continue;
    pairs.push({
      tryIndex: m.index,
      tryBodyStart: tryOpen + 1,
      tryBodyEnd: tryClose,
      finallyBodyStart: finOpen + 1,
      finallyBodyEnd: finClose,
      tryBody: text.slice(tryOpen + 1, tryClose),
      finallyBody: text.slice(finOpen + 1, finClose),
    });
  }
  return pairs;
}

function bodyHasTaskCall(body) {
  return /\btask\s*\(\s*lease\b/.test(maskJsNonCode(body));
}

function bodyHasLeaseDelete(body) {
  return /activeAuditIntegrityWriteLeases\s*\.\s*delete\s*\(/.test(maskJsNonCode(body));
}

function bodyHasAwaitRelease(body, handleName) {
  const masked = maskJsNonCode(body);
  if (handleName) {
    return new RegExp(
      `await\\s+${escapeRegExp(RELEASE_API)}\\s*\\(\\s*${escapeRegExp(handleName)}\\s*\\)`,
    ).test(masked);
  }
  return new RegExp(`await\\s+${escapeRegExp(RELEASE_API)}\\s*\\(`).test(masked);
}

function bodyHasLeaseMint(body) {
  return /activeAuditIntegrityWriteLeases\s*\.\s*set\s*\(/.test(maskJsNonCode(body));
}

/**
 * P1-A: Distinct nested try/finally pairs (not same finally for delete+release).
 */
function analyzeQueueExecutableOrder(queueSource) {
  const enqueueBody = extractFunctionBody(queueSource, 'enqueueAuditIntegrityWriteTask');
  if (enqueueBody == null) {
    return { ok: false, reason: 'missing-enqueue-body' };
  }
  const thenBody = extractFifoThenAsyncBody(enqueueBody);
  if (thenBody == null) {
    return { ok: false, reason: 'missing-then-async-body' };
  }
  const masked = maskJsNonCode(thenBody);

  const acqRe = new RegExp(
    `(?:const|let|var)\\s+(\\w+)\\s*=\\s*await\\s+${escapeRegExp(ACQUIRE_API)}\\s*\\(`,
  );
  const acqM = acqRe.exec(masked);
  const awaitAcquire = acqM != null;
  const handleName = acqM ? acqM[1] : null;
  const acqIdx = acqM ? acqM.index : -1;
  // end of acquire statement roughly
  const acqEnd = acqM
    ? (() => {
      let i = acqM.index;
      while (i < masked.length && masked[i] !== ';') i += 1;
      return i;
    })()
    : -1;

  const pairs = extractTryFinallyPairs(thenBody);

  // Inner: try has task(lease); finally has delete ONLY (no release)
  const innerCandidates = pairs.filter((p) => {
    if (!bodyHasTaskCall(p.tryBody)) return false;
    if (!bodyHasLeaseDelete(p.finallyBody)) return false;
    if (bodyHasAwaitRelease(p.finallyBody, handleName)) return false;
    if (bodyHasLeaseDelete(p.tryBody) && !bodyHasLeaseDelete(p.finallyBody)) return false;
    // finally should not contain mint
    if (bodyHasLeaseMint(p.finallyBody)) return false;
    return true;
  });

  // Outer: try has mint + contains an inner pair range; finally has await release only (no delete)
  const outerCandidates = pairs.filter((p) => {
    if (!bodyHasLeaseMint(p.tryBody)) return false;
    if (!bodyHasAwaitRelease(p.finallyBody, handleName)) return false;
    if (bodyHasLeaseDelete(p.finallyBody)) return false;
    if (bodyHasAwaitRelease(p.tryBody, handleName)) return false;
    // Outer try must start after acquire
    if (awaitAcquire && p.tryIndex <= acqEnd) return false;
    return true;
  });

  let structuralOk = false;
  let chosenInner = null;
  let chosenOuter = null;
  for (const outer of outerCandidates) {
    for (const inner of innerCandidates) {
      if (inner === outer) continue;
      // Distinct finally ranges
      if (inner.finallyBodyStart === outer.finallyBodyStart) continue;
      // Inner fully nested inside outer try body
      if (
        inner.tryIndex > outer.tryBodyStart
        && inner.finallyBodyEnd < outer.tryBodyEnd
      ) {
        // mint before inner try (in outer try text before inner)
        const beforeInner = thenBody.slice(outer.tryBodyStart, inner.tryIndex);
        if (!bodyHasLeaseMint(beforeInner)) continue;
        // task only in inner try
        if (!bodyHasTaskCall(inner.tryBody)) continue;
        chosenInner = inner;
        chosenOuter = outer;
        structuralOk = true;
        break;
      }
    }
    if (structuralOk) break;
  }

  const awaitRelease = handleName
    ? bodyHasAwaitRelease(thenBody, handleName)
    : false;

  const mintIdx = firstMemberCallIndex(thenBody, 'activeAuditIntegrityWriteLeases', 'set');
  const delIdx = firstMemberCallIndex(thenBody, 'activeAuditIntegrityWriteLeases', 'delete');
  const taskM = /\btask\s*\(\s*lease\b/.exec(masked);
  const taskIdx = taskM ? taskM.index : -1;
  const relRe = handleName
    ? new RegExp(
      `await\\s+${escapeRegExp(RELEASE_API)}\\s*\\(\\s*${escapeRegExp(handleName)}\\s*\\)`,
    )
    : null;
  const relM = relRe ? relRe.exec(masked) : null;
  const relIdx = relM ? relM.index : -1;

  const ok =
    awaitAcquire
    && awaitRelease
    && handleName != null
    && structuralOk
    && chosenInner != null
    && chosenOuter != null;

  return {
    ok,
    reason: ok ? 'ok' : 'lifecycle',
    awaitAcquire,
    awaitRelease,
    handleName,
    acqIdx,
    mintIdx,
    taskIdx,
    delIdx,
    relIdx,
    structuralOk,
    distinctFinally: Boolean(
      chosenInner
      && chosenOuter
      && chosenInner.finallyBodyStart !== chosenOuter.finallyBodyStart,
    ),
    acquireBeforeMint: acqIdx >= 0 && mintIdx >= 0 && acqIdx < mintIdx,
    taskAfterMint: taskIdx >= 0 && mintIdx >= 0 && taskIdx > mintIdx,
    releaseAfterExpire: relIdx >= 0 && delIdx >= 0 && relIdx > delIdx,
  };
}

function findStructuralClosedSetLengthLocks(source, count) {
  const n = Number(count);
  const masked = maskJsNonCode(source);
  const hits = [];
  const patterns = [
    new RegExp(
      String.raw`Object\.keys\(\s*ERROR_CODES\s*\)\.length\s*,\s*${n}\b`,
      'g',
    ),
    new RegExp(
      String.raw`Object\.keys\(\s*ERROR_CODES\s*\)\.length\s*===\s*${n}\b`,
      'g',
    ),
    new RegExp(
      String.raw`Object\.keys\(\s*ERROR_CODES\s*\)\.length\s*==\s*${n}\b`,
      'g',
    ),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(masked)) !== null) {
      hits.push({ kind: 'structural', index: m.index, count: n });
    }
  }
  return hits;
}

function staticImportsProcessLockModule(source) {
  const specs = collectStaticImportSpecifiers(source);
  for (const s of specs) {
    if (/(^|\/)audit-integrity-process-lock\.js$/.test(s)) return true;
  }
  return false;
}

/**
 * Bounded recursive list of .js files under SRC_DIR (never escapes src).
 * @returns {Promise<string[]>} paths relative to SRC_DIR using /
 */
async function listSrcJsRelativePaths() {
  const out = [];

  async function walk(absDir) {
    const resolved = resolve(absDir);
    if (resolved !== SRC_DIR && !resolved.startsWith(`${SRC_DIR}/`)) return;
    let entries;
    try {
      entries = await readdir(resolved, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(resolved, ent.name);
      const fullRes = resolve(full);
      if (fullRes !== SRC_DIR && !fullRes.startsWith(`${SRC_DIR}/`)) continue;
      if (ent.isDirectory()) {
        await walk(fullRes);
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        out.push(relative(SRC_DIR, fullRes).split('\\').join('/'));
      }
    }
  }

  await walk(SRC_DIR);
  out.sort();
  return out;
}

/**
 * Sole production importers of process-lock.
 * @param {Map<string, string> | null} fileMap relPath → source (synthetic)
 * @returns {Promise<string[]>} sorted rel paths of importers
 */
async function listProductionProcessLockImporters(fileMap = null) {
  /** @type {string[]} */
  const rels = fileMap
    ? [...fileMap.keys()].sort()
    : await listSrcJsRelativePaths();

  const importers = [];
  for (const rel of rels) {
    // Exclude only exact root module path — nested same basename still scanned (P2).
    if (rel === PROCESS_LOCK_MODULE) continue;
    const text = fileMap
      ? fileMap.get(rel)
      : await readFile(join(SRC_DIR, rel), 'utf8');
    if (typeof text !== 'string') continue;
    if (staticImportsProcessLockModule(text)) importers.push(rel);
  }
  return importers;
}

function pathUnderAllowedRoot(absPath) {
  const r = resolve(absPath);
  const allowed = [SRC_DIR, DOCS_DIR, TEST_DIR, join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'package.json')];
  // PATH entries may be files under roots
  if (r === resolve(REPO_ROOT, 'README.md') || r === resolve(REPO_ROOT, 'package.json')) {
    return true;
  }
  return (
    r.startsWith(`${SRC_DIR}/`)
    || r.startsWith(`${DOCS_DIR}/`)
    || r.startsWith(`${TEST_DIR}/`)
    || r === SRC_DIR
    || r === DOCS_DIR
    || r === TEST_DIR
  );
}

async function readText(absPath) {
  return readFile(absPath, 'utf8');
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-pl-scan-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── Production-shaped golden fixture snippets for canaries ───────────────

function goodWaitForLockfModule() {
  return `
const LOCKF_BINARY = '/usr/bin/lockf';
const LOCKF_ARGV = Object.freeze(['-s', '-t', '5', '3']);
function waitForLockf(spawnImpl, fd) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', fd],
      env: Object.create(null),
    });
    child.on('exit', () => resolve());
  });
}
export async function acquireAuditIntegrityProcessLock() {}
`;
}

function goodAttrModule() {
  return `
async function assertLockFileAttributes(fileHandle, canonicalAbs, runtime) {
  let fdStat;
  let pathStat;
  fdStat = await fileHandle.stat();
  pathStat = await runtime.lstat(canonicalAbs);
  if (typeof fdStat.isFile !== 'function' || !fdStat.isFile()) throwUnavailable();
  if (typeof pathStat.isFile !== 'function' || !pathStat.isFile()) throwUnavailable();
  if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) throwUnavailable();
  if (fdStat.nlink !== 1 || pathStat.nlink !== 1) throwUnavailable();
  if ((fdStat.mode & 0o777) !== 0o600 || (pathStat.mode & 0o777) !== 0o600) {
    throwUnavailable();
  }
  if (typeof runtime.geteuid !== 'function') throwUnavailable();
  let euid;
  try {
    euid = runtime.geteuid();
  } catch {
    throwUnavailable();
  }
  if (fdStat.uid !== euid || pathStat.uid !== euid) throwUnavailable();
}
async function waitForLockf() {}
export async function acquireAuditIntegrityProcessLock() {
  try {
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    await waitForLockf(runtime.spawn, fileHandle.fd);
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
  } catch (error) {
    throw error;
  }
}
`;
}

function goodQueueModule() {
  return `
export function enqueueAuditIntegrityWriteTask(resolvedRoot, task) {
  const previous = Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const processLockHandle = await acquireAuditIntegrityProcessLock(root);
    try {
      const lease = Object.freeze(Object.create(null));
      activeAuditIntegrityWriteLeases.set(lease, { resolvedRoot: root });
      const observer = {};
      try {
        return await als.run(lease, async () => await task(lease, observer));
      } finally {
        activeAuditIntegrityWriteLeases.delete(lease);
      }
    } finally {
      await releaseAuditIntegrityProcessLock(processLockHandle);
    }
  });
  return run;
}
`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Canaries — prove scanners catch violations (and would false-green under OLD)
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 canary: sole production importer scanner', () => {
  it('catches second importer incl nested; nested same-basename not self-excluded; camouflage ignored', async () => {
    const sole = new Map([
      [PROCESS_LOCK_MODULE, 'export async function acquire() {}'],
      [WRITE_QUEUE_MODULE, `import { ${ACQUIRE_API} } from '${PROCESS_LOCK_SPEC}';\n`],
      ['audit-log.js', 'export function append() {}\n'],
      ['web/app.js', 'export const x = 1;\n'],
    ]);
    assert.deepEqual(await listProductionProcessLockImporters(sole), [WRITE_QUEUE_MODULE]);

    const nested = new Map(sole);
    nested.set(
      'web/evil.js',
      `import { ${ACQUIRE_API} } from '../audit-integrity-process-lock.js';\n`,
    );
    assert.deepEqual(
      await listProductionProcessLockImporters(nested),
      [WRITE_QUEUE_MODULE, 'web/evil.js'],
    );

    // P2: nested basename equals process-lock module must NOT be excluded as self
    const nestedSameName = new Map(sole);
    nestedSameName.set(
      'web/audit-integrity-process-lock.js',
      `import { ${ACQUIRE_API} } from '../audit-integrity-process-lock.js';\n`,
    );
    assert.deepEqual(
      await listProductionProcessLockImporters(nestedSameName),
      [WRITE_QUEUE_MODULE, 'web/audit-integrity-process-lock.js'],
      'nested same basename must count as importer',
    );

    const camouflage = new Map([
      [PROCESS_LOCK_MODULE, 'export async function acquire() {}'],
      [
        WRITE_QUEUE_MODULE,
        [
          `import { ${ACQUIRE_API} } from '${PROCESS_LOCK_SPEC}';`,
          `// import { ${ACQUIRE_API} } from '${PROCESS_LOCK_SPEC}';`,
          `const s = "import { x } from '${PROCESS_LOCK_SPEC}'";`,
        ].join('\n'),
      ],
      ['server.js', `// from '${PROCESS_LOCK_SPEC}'\nexport const x = 1;\n`],
    ]);
    assert.deepEqual(
      await listProductionProcessLockImporters(camouflage),
      [WRITE_QUEUE_MODULE],
    );
  });
});

describe('C4 canary P1-1/2: spawn contract bound to real waitForLockf call', () => {
  it('accepts production-shaped spawn; decoy const + real drift each fail', () => {
    const good = goodWaitForLockfModule();
    const g = analyzeLockfSpawnContract(good);
    assert.equal(g.ok, true, `good spawn: ${g.reason}`);
    assert.equal(g.spawnCallCount, 1);
    assert.equal(g.binaryOk, true);
    assert.equal(g.argvExact, true);
    assert.equal(g.shellFalse, true);
    assert.equal(g.envCreateNull, true);
    assert.equal(g.fdForm, true);

    // Correct decoys remain; actual spawn binary/argv/shell/env/fd drift → fail
    const decoyHeader = `
const LOCKF_BINARY = '/usr/bin/lockf';
const LOCKF_ARGV = Object.freeze(['-s', '-t', '5', '3']);
const DECOY_OPTS = { shell: false, env: Object.create(null), stdio: ['ignore','ignore','ignore', 3] };
`;

    const binaryDrift = `${decoyHeader}
function waitForLockf(spawnImpl, fd) {
  spawnImpl('/bin/lockf', [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(binaryDrift).binaryOk, false, 'binary drift');
    assert.equal(analyzeLockfSpawnContract(binaryDrift).ok, false);

    const argvDrift = `${decoyHeader}
function waitForLockf(spawnImpl, fd) {
  spawnImpl(LOCKF_BINARY, ['-t', '0'], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(argvDrift).argvExact, false, 'argv drift');
    assert.equal(analyzeLockfSpawnContract(argvDrift).ok, false);

    const shellDrift = `${decoyHeader}
function waitForLockf(spawnImpl, fd) {
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: true,
    stdio: ['ignore', 'ignore', 'ignore', fd],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(shellDrift).shellFalse, false, 'shell drift');
    assert.equal(analyzeLockfSpawnContract(shellDrift).ok, false);

    const envDrift = `${decoyHeader}
function waitForLockf(spawnImpl, fd) {
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd],
    env: process.env,
  });
}
`;
    const e = analyzeLockfSpawnContract(envDrift);
    assert.equal(e.envCreateNull, false, 'env drift');
    assert.equal(e.inheritsProcessEnv, true);
    assert.equal(e.ok, false);

    const fdDrift = `${decoyHeader}
function waitForLockf(spawnImpl, fd) {
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(fdDrift).fdForm, false, 'fd missing');
    assert.equal(analyzeLockfSpawnContract(fdDrift).ok, false);

    // Wrong fd identifier (not the param)
    const fdIdentDrift = `${decoyHeader}
function waitForLockf(spawnImpl, fd) {
  const other = 9;
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', other],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(fdIdentDrift).fdForm, false, 'fd ident drift');

    // P2: comment-only exact freeze in RHS must not green
    const commentFreeze = `
const LOCKF_BINARY = '/usr/bin/lockf';
const LOCKF_ARGV = bad /* Object.freeze(['-s', '-t', '5', '3']) */;
function waitForLockf(spawnImpl, fd) {
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(commentFreeze).argvExact, false, 'comment freeze RHS');

    // P2: stdio fifth element must fail
    const stdioFive = `
const LOCKF_BINARY = '/usr/bin/lockf';
const LOCKF_ARGV = Object.freeze(['-s', '-t', '5', '3']);
function waitForLockf(spawnImpl, fd) {
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd, 'ignore'],
    env: Object.create(null),
  });
}
`;
    assert.equal(analyzeLockfSpawnContract(stdioFive).fdForm, false, 'stdio five elems');

    // P2: comment signature must not supply params
    const commentSig = `
const LOCKF_BINARY = '/usr/bin/lockf';
const LOCKF_ARGV = Object.freeze(['-s', '-t', '5', '3']);
// function waitForLockf(spawnImpl, fd) {}
function waitForLockf(spawnImpl, otherFd) {
  spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', fd],
    env: Object.create(null),
  });
}
`;
    // real param is otherFd; stdio uses unbound fd → fail
    assert.equal(analyzeLockfSpawnContract(commentSig).fdForm, false, 'comment sig ignored');
  });
});

describe('C4 canary P1-1/2: exact gate cond + same-try direct await', () => {
  it('exact conditions/direct-block only; false&&/nested/try-wrap fail; try depth fail', () => {
    const good = goodAttrModule();
    assert.equal(analyzeAttrGates(good).ok, true, 'good attrs');
    assert.equal(analyzePostExit0Revalidation(good).ok, true, 'good post direct try');

    // P1-1: false && exact needle — must fail (no substring)
    const falseAnd = goodAttrModule().replace(
      "typeof fdStat.isFile !== 'function' || !fdStat.isFile()",
      "false && (typeof fdStat.isFile !== 'function' || !fdStat.isFile())",
    );
    assert.equal(analyzeAttrGates(falseAnd).regularBoth, false, 'false&&gate');
    assert.equal(analyzeAttrGates(falseAnd).ok, false);

    // P1-1: exact gate && dynamicFlag
    const andFlag = goodAttrModule().replace(
      "typeof fdStat.isFile !== 'function' || !fdStat.isFile()",
      "(typeof fdStat.isFile !== 'function' || !fdStat.isFile()) && dynamicFlag",
    );
    assert.equal(analyzeAttrGates(andFlag).regularBoth, false, 'gate&&flag');

    // P1-1: if(flag){ correct gate + throw } — nested, not direct
    const nestedFlag = `
async function assertLockFileAttributes(fileHandle, canonicalAbs, runtime) {
  const fdStat = await fileHandle.stat();
  const pathStat = await runtime.lstat(canonicalAbs);
  if (flag) {
    if (typeof fdStat.isFile !== 'function' || !fdStat.isFile()) throwUnavailable();
    if (typeof pathStat.isFile !== 'function' || !pathStat.isFile()) throwUnavailable();
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) throwUnavailable();
    if (fdStat.nlink !== 1 || pathStat.nlink !== 1) throwUnavailable();
    if ((fdStat.mode & 0o777) !== 0o600 || (pathStat.mode & 0o777) !== 0o600) throwUnavailable();
    if (typeof runtime.geteuid !== 'function') throwUnavailable();
    if (fdStat.uid !== euid || pathStat.uid !== euid) throwUnavailable();
  }
  try { euid = runtime.geteuid(); } catch { throwUnavailable(); }
}
`;
    assert.equal(analyzeAttrGates(nestedFlag).ok, false, 'if(flag) nest');
    assert.equal(analyzeAttrGates(nestedFlag).regularBoth, false);

    // P1-1: try { correct gate + throw } — not direct if of body
    const tryWrapGate = `
async function assertLockFileAttributes(fileHandle, canonicalAbs, runtime) {
  const fdStat = await fileHandle.stat();
  const pathStat = await runtime.lstat(canonicalAbs);
  try {
    if (typeof fdStat.isFile !== 'function' || !fdStat.isFile()) throwUnavailable();
    if (typeof pathStat.isFile !== 'function' || !pathStat.isFile()) throwUnavailable();
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) throwUnavailable();
    if (fdStat.nlink !== 1 || pathStat.nlink !== 1) throwUnavailable();
    if ((fdStat.mode & 0o777) !== 0o600 || (pathStat.mode & 0o777) !== 0o600) throwUnavailable();
    if (typeof runtime.geteuid !== 'function') throwUnavailable();
    if (fdStat.uid !== euid || pathStat.uid !== euid) throwUnavailable();
  } catch { throwUnavailable(); }
  try { euid = runtime.geteuid(); } catch { throwUnavailable(); }
}
`;
    assert.equal(analyzeAttrGates(tryWrapGate).regularBoth, false, 'try-wrap gates');
    assert.equal(analyzeAttrGates(tryWrapGate).ok, false);

    // mode 0o644 / === / bare still fail
    assert.equal(analyzeAttrGates(goodAttrModule().replaceAll('0o600', '0o644')).modeBoth, false);
    assert.equal(
      analyzeAttrGates(
        goodAttrModule().replaceAll('!== 0o600', '=== 0o600'),
      ).modeBoth,
      false,
    );

    // reverse isFile positive throw
    const reverseIsFile = goodAttrModule()
      .replaceAll("typeof fdStat.isFile !== 'function' || !fdStat.isFile()", 'fdStat.isFile()')
      .replaceAll("typeof pathStat.isFile !== 'function' || !pathStat.isFile()", 'pathStat.isFile()');
    assert.equal(analyzeAttrGates(reverseIsFile).regularBoth, false);

    // geteuid !== undefined (not string 'function')
    assert.equal(
      analyzeAttrGates(
        goodAttrModule().replace(
          "typeof runtime.geteuid !== 'function'",
          'typeof runtime.geteuid !== undefined',
        ),
      ).geteuidTypeofFailClosed,
      false,
    );

    // dead if(false) with correct gates+throw
    const deadThrow = `
async function assertLockFileAttributes(fileHandle, canonicalAbs, runtime) {
  const fdStat = await fileHandle.stat();
  const pathStat = await runtime.lstat(canonicalAbs);
  if (false) {
    if (typeof fdStat.isFile !== 'function' || !fdStat.isFile()) throwUnavailable();
    if (typeof pathStat.isFile !== 'function' || !pathStat.isFile()) throwUnavailable();
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) throwUnavailable();
    if (fdStat.nlink !== 1 || pathStat.nlink !== 1) throwUnavailable();
    if ((fdStat.mode & 0o777) !== 0o600 || (pathStat.mode & 0o777) !== 0o600) throwUnavailable();
    if (typeof runtime.geteuid !== 'function') throwUnavailable();
    if (fdStat.uid !== euid || pathStat.uid !== euid) throwUnavailable();
    try { runtime.geteuid(); } catch { throwUnavailable(); }
  }
}
`;
    assert.equal(analyzeAttrGates(deadThrow).ok, false, 'dead branch');

    // P1-2: outer pre + inner wait/post
    const outerPreInnerRest = `
async function assertLockFileAttributes() {}
async function waitForLockf() {}
export async function acquireAuditIntegrityProcessLock() {
  try {
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    try {
      await waitForLockf(runtime.spawn, fileHandle.fd);
      await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    } catch (e) {}
  } catch (e) {}
}
`;
    assert.equal(analyzePostExit0Revalidation(outerPreInnerRest).ok, false, 'outer pre + inner rest');

    // P1-2: outer pre/wait + inner post
    const outerPreWaitInnerPost = `
async function assertLockFileAttributes() {}
async function waitForLockf() {}
export async function acquireAuditIntegrityProcessLock() {
  try {
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    await waitForLockf(runtime.spawn, fileHandle.fd);
    try {
      await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    } catch (e) {}
  } catch (e) {}
}
`;
    assert.equal(
      analyzePostExit0Revalidation(outerPreWaitInnerPost).ok,
      false,
      'outer pre/wait + inner post',
    );

    // P1-2: complete order only in inner try — inner itself may pass
    const allInner = `
async function assertLockFileAttributes() {}
async function waitForLockf() {}
export async function acquireAuditIntegrityProcessLock() {
  try {
    try {
      await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
      await waitForLockf(runtime.spawn, fileHandle.fd);
      await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    } catch (e) {}
  } catch (e) {}
}
`;
    assert.equal(analyzePostExit0Revalidation(allInner).ok, true, 'inner complete order ok');

    // P1-2: dynamic if wraps wait
    const ifWrapWait = `
async function assertLockFileAttributes() {}
async function waitForLockf() {}
export async function acquireAuditIntegrityProcessLock() {
  try {
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    if (flag) {
      await waitForLockf(runtime.spawn, fileHandle.fd);
    }
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
  } catch (e) {}
}
`;
    assert.equal(analyzePostExit0Revalidation(ifWrapWait).ok, false, 'if-wrap wait');

    // if(false) all three
    const allDead = `
async function assertLockFileAttributes() {}
async function waitForLockf() {}
export async function acquireAuditIntegrityProcessLock() {
  try {
    if (false) {
      await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
      await waitForLockf(runtime.spawn, fileHandle.fd);
      await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
    }
  } catch (e) {}
}
`;
    assert.equal(analyzePostExit0Revalidation(allDead).ok, false, 'all in if(false)');
  });
});

describe('C4 canary P1-A: queue distinct nested try/finally', () => {
  it('accepts distinct pairs; same-finally delete+release fails; unrelated finally ignored', () => {
    const good = goodQueueModule();
    const g = analyzeQueueExecutableOrder(good);
    assert.equal(g.ok, true, `good queue: ${g.reason}`);
    assert.equal(g.structuralOk, true);
    assert.equal(g.distinctFinally, true);

    // OLD false-green: single finally with delete then await release; outer empty
    const sameFinally = `
export function enqueueAuditIntegrityWriteTask(resolvedRoot, task) {
  const previous = Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const processLockHandle = await ${ACQUIRE_API}(root);
    try {
      const lease = Object.freeze(Object.create(null));
      activeAuditIntegrityWriteLeases.set(lease, { resolvedRoot: root });
      return await task(lease, observer);
    } finally {
      activeAuditIntegrityWriteLeases.delete(lease);
      await ${RELEASE_API}(processLockHandle);
    }
  });
  return run;
}
`;
    assert.equal(analyzeQueueExecutableOrder(sameFinally).ok, false, 'same finally must fail');

    // Drop await on acquire
    const noAcqAwait = good.replace(
      `const processLockHandle = await ${ACQUIRE_API}(root);`,
      `const processLockHandle = ${ACQUIRE_API}(root);`,
    );
    assert.equal(analyzeQueueExecutableOrder(noAcqAwait).awaitAcquire, false);

    // delete outside finally
    const delOut = `
export function enqueueAuditIntegrityWriteTask(resolvedRoot, task) {
  const previous = Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const processLockHandle = await ${ACQUIRE_API}(root);
    try {
      const lease = Object.freeze(Object.create(null));
      activeAuditIntegrityWriteLeases.set(lease, { resolvedRoot: root });
      try {
        return await task(lease, observer);
      } finally {
        /* empty */
      }
      activeAuditIntegrityWriteLeases.delete(lease);
    } finally {
      await ${RELEASE_API}(processLockHandle);
    }
  });
  return run;
}
`;
    assert.equal(analyzeQueueExecutableOrder(delOut).ok, false, 'delete outside finally');

    // Unrelated finally cannot satisfy
    const unrelated = `
export function enqueueAuditIntegrityWriteTask(resolvedRoot, task) {
  const previous = Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const processLockHandle = await ${ACQUIRE_API}(root);
    try {
      const lease = Object.freeze(Object.create(null));
      activeAuditIntegrityWriteLeases.set(lease, { resolvedRoot: root });
      try {
        return await task(lease, observer);
      } finally {
        /* no delete */
      }
    } finally {
      await ${RELEASE_API}(processLockHandle);
    }
    try { other(); } finally { activeAuditIntegrityWriteLeases.delete(lease); }
  });
  return run;
}
`;
    assert.equal(analyzeQueueExecutableOrder(unrelated).ok, false, 'unrelated finally');

    // mint/observer before inner try still needs outer release (good structure variant)
    const mintBeforeInner = goodQueueModule();
    assert.equal(analyzeQueueExecutableOrder(mintBeforeInner).ok, true, 'mint before inner');
  });
});

describe('C4 canary P1-B: honesty inventory-local only', () => {
  it('Out of scope X; PHRASE fails; PHRASE is not BLOCKED fails; legal headers pass', () => {
    assert.equal(
      findUnqualifiedHonestyPhraseLines('T6d.3 complete and ready', 'T6d.3 complete').length,
      1,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Out of scope X; T6d.3 complete',
        'T6d.3 complete',
      ).length,
      1,
      'Out of scope X must not shelter',
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Out of scope X; production-hardening ready',
        'production-hardening ready',
      ).length,
      1,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'T6d.3 complete is not BLOCKED',
        'T6d.3 complete',
      ).length,
      1,
      'is not BLOCKED must fail',
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'M6d Exit is not BLOCKED',
        'M6d Exit',
      ).length,
      1,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines('Not X but T6d.3 complete', 'T6d.3 complete').length,
      1,
    );

    // Legal inventory headers
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '**Not:** T6d.3 complete / M6d Exit / production-hardening ready',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '**Not:** T6d.3 complete / M6d Exit / production-hardening ready',
        'M6d Exit',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'FORBIDDEN as delivered:\n  T6d.3 complete | M6d Exit',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '**Out of scope：** distributed；e2e delivery；M6d Exit；Gold ready',
        'M6d Exit',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '| M6d Exit / Gold | **否** |',
        'M6d Exit',
      ).length,
      0,
      'table cell 否',
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines('not T6d.3 complete', 'T6d.3 complete').length,
      0,
    );

    // P2: plain JSDoc "* phrase" after BLOCKED must NOT inherit; "* - phrase" may
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'BLOCKED:\n * T6d.3 complete delivered',
        'T6d.3 complete',
      ).length,
      1,
      'plain JSDoc star prose must not inherit inventory',
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'BLOCKED:\n * - T6d.3 complete',
        'T6d.3 complete',
      ).length,
      0,
      'JSDoc * - item is inventory',
    );

    // P2: generic "no false X and PHRASE" must fail
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'no false X and T6d.3 complete',
        'T6d.3 complete',
      ).length,
      1,
      'no false X and phrase must fail',
    );
    // tight "no false claim that PHRASE" ok
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'no false claim that T6d.3 complete',
        'T6d.3 complete',
      ).length,
      0,
    );
  });
});

describe('C4 canary: forbidden algorithm + closed-set structural', () => {
  it('flags linkSync/hardlink/fs.link/repair; prior/next closed-set; ignores comment decoys', () => {
    const clean = `
      /** Never unlink/rename/chmod; hard-link reclaim rejected. */
      export async function acquire() { await waitForLockf(spawn, fd); }
    `;
    assert.equal(analyzeForbiddenSelectedAlgorithms(clean).ok, true);

    assert.ok(
      analyzeForbiddenSelectedAlgorithms(
        'export function x(a,b){ return linkSync(a,b); }\n',
      ).findings.includes('linkSync'),
    );
    assert.ok(
      analyzeForbiddenSelectedAlgorithms(
        'const mode = hardlink;\nexport function x(){ return mode; }\n',
      ).findings.includes('hardlink-word'),
    );
    assert.ok(
      analyzeForbiddenSelectedAlgorithms(
        'import fs from "node:fs";\nexport function x(a,b){ return fs.link(a,b); }\n',
      ).findings.includes('fs-link'),
    );

    const prior = priorClosedSetCount();
    const cur = currentClosedSetCount();
    const next = nextClosedSetCount();
    assert.ok(
      findStructuralClosedSetLengthLocks(
        `assert.equal(Object.keys(ERROR_CODES).length, ${prior});`,
        prior,
      ).length >= 1,
    );
    assert.ok(
      findStructuralClosedSetLengthLocks(
        `assert.equal(Object.keys(ERROR_CODES).length, ${next});`,
        next,
      ).length >= 1,
    );
    assert.deepEqual(
      findStructuralClosedSetLengthLocks(
        `assert.equal(Object.keys(ERROR_CODES).length, ${cur});`,
        prior,
      ),
      [],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Production scans
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 S1: sole production importer of process-lock is write-queue', () => {
  it('S1. bounded recursive src/**/*.js: exact one importer write-queue; self excluded', async () => {
    const importers = await listProductionProcessLockImporters();
    assert.deepEqual(
      importers,
      [WRITE_QUEUE_MODULE],
      `expected sole importer ${WRITE_QUEUE_MODULE}, got ${importers.join(',') || '(none)'}`,
    );

    const queue = await readText(PATHS.writeQueue);
    const specs = collectStaticImportSpecifiers(queue);
    assert.equal(
      specs.filter((s) => s === PROCESS_LOCK_SPEC).length,
      1,
      'write-queue static-import process-lock once',
    );
    const bindings = collectImportedBindingsFromSpecifier(queue, PROCESS_LOCK_SPEC);
    assert.ok(bindings.includes(ACQUIRE_API), 'queue imports acquire');
    assert.ok(bindings.includes(RELEASE_API), 'queue imports release');
    assert.equal(
      /\bexport\s+async\s+function\s+acquireAuditIntegrityProcessLock\b/.test(
        maskJsNonCode(queue),
      ),
      false,
    );
  });
});

describe('C4 S2: process-lock lockf spawn contract (bound call)', () => {
  it('S2. unique waitForLockf spawnImpl: binary/argv/shell/env/fd exact', async () => {
    const source = await readText(PATHS.processLock);
    const c = analyzeLockfSpawnContract(source);
    assert.equal(c.spawnCallCount, 1, 'single real spawn call');
    assert.equal(c.binaryOk, true, 'LOCKF_BINARY absolute lockf');
    assert.equal(c.argvExact, true, 'LOCKF_ARGV freeze -s -t 5 3');
    assert.equal(c.shellFalse, true, 'shell:false');
    assert.equal(c.envCreateNull, true, 'env Object.create(null)');
    assert.equal(c.inheritsProcessEnv, false, 'no process.env');
    assert.equal(c.fdForm, true, 'stdio fd form');
    assert.equal(c.ok, true, c.reason);

    assert.equal(/\bspawnSync\b/.test(maskJsNonCode(source)), false, 'no spawnSync');

    const mod = await import('../src/audit-integrity-process-lock.js');
    assert.equal(typeof mod[ACQUIRE_API], 'function');
    assert.equal(typeof mod[RELEASE_API], 'function');
    assert.equal(mod.AUDIT_INTEGRITY_PROCESS_LOCK_TIMEOUT_SECONDS, 5);
  });
});

describe('C4 S3: mandatory post-exit-0 await revalidation + strict attr gates', () => {
  it('S3. await pre+post; fdStat/pathStat regular/dev/ino/nlink/mode/geteuid/uid', async () => {
    const source = await readText(PATHS.processLock);
    const post = analyzePostExit0Revalidation(source);
    assert.equal(post.hasAwaitWait, true, 'await waitForLockf');
    assert.ok(post.preCount >= 1, 'await pre attr');
    assert.ok(post.postCount >= 1, 'await post attr');
    assert.equal(post.ok, true);

    const attrs = analyzeAttrGates(source);
    assert.equal(attrs.regularBoth, true);
    assert.equal(attrs.sameDev, true);
    assert.equal(attrs.sameIno, true);
    assert.equal(attrs.nlinkBoth, true);
    assert.equal(attrs.modeBoth, true);
    assert.equal(attrs.geteuidTypeofFailClosed, true);
    assert.equal(attrs.geteuidCall, true);
    assert.equal(attrs.uidBoth, true);
    assert.equal(attrs.ok, true);
  });
});

describe('C4 S4: selected algorithm excludes reclaim/repair protocols', () => {
  it('S4. no hardlink/linkSync/orphan/owner-json; no unlink/rename/chmod repair calls', async () => {
    const source = await readText(PATHS.processLock);
    const f = analyzeForbiddenSelectedAlgorithms(source);
    assert.deepEqual(f.findings, [], `forbidden markers: ${f.findings.join(',')}`);
    assert.equal(f.ok, true);
    assert.equal(
      new RegExp(`\\b${escapeRegExp(orphanGraceNeedle())}\\b`).test(maskJsNonCode(source)),
      false,
    );
  });
});

describe('C4 S5: honesty on truth surfaces (phrase-local)', () => {
  it('S5. process-lock/queue/readme/gold/package/plan/spec/version: phrases qualified', async () => {
    const targets = {
      processLock: await readText(PATHS.processLock),
      writeQueue: await readText(PATHS.writeQueue),
      readme: await readText(PATHS.readme),
      gold: await readText(PATHS.gold),
      packageJson: await readText(PATHS.packageJson),
      version: await readText(PATHS.version),
      v140Plan: await readText(PATHS.v140Plan),
      v140Spec: await readText(PATHS.v140Spec),
    };
    for (const [label, text] of Object.entries(targets)) {
      for (const phrase of HONESTY_PHRASES) {
        if (!text.includes(phrase)) continue;
        assertHonestyPhraseQualified(text, phrase, label);
      }
    }

    const lock = targets.processLock;
    assert.ok(/network FS/i.test(lock) || /Network FS/.test(lock), 'process-lock network FS boundary');
    assert.ok(
      /not detected/i.test(lock) || /OUT OF CONTRACT/i.test(lock),
      'process-lock not auto-detect',
    );

    // Structural canaries (finder itself)
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Not X but T6d.3 complete; production-hardening ready',
        'T6d.3 complete',
      ).length,
      1,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'X is not blocked, e2e delivered',
        'e2e delivered',
      ).length,
      1,
    );
  });
});

describe('C4 S6: queue executable lifecycle structure', () => {
  it('S6. then(async): await acquire, mint, task, finally delete, finally await release', async () => {
    const queue = await readText(PATHS.writeQueue);
    const order = analyzeQueueExecutableOrder(queue);
    assert.equal(order.awaitAcquire, true, 'await acquire');
    assert.equal(order.awaitRelease, true, 'await release');
    assert.equal(order.structuralOk, true, 'try/finally structure');
    assert.equal(order.ok, true, order.reason);
    assert.equal(countCallSites(queue, ACQUIRE_API), 1);
    assert.equal(countCallSites(queue, RELEASE_API), 1);
  });
});

describe('C4 S7: ERROR_CODES current closed-set; process-lock unique; suite coord', () => {
  it('S7. runtime length; unique process-lock; coord error-codes + admission scans; no prior/next pin in self', async () => {
    const cur = currentClosedSetCount();
    const prior = priorClosedSetCount();
    const next = nextClosedSetCount();
    assert.equal(Object.keys(ERROR_CODES).length, cur);
    assert.equal(
      ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE,
      'audit-integrity-process-lock-unavailable',
    );
    const values = Object.values(ERROR_CODES);
    assert.equal(new Set(values).size, values.length);
    assert.equal(
      values.filter((v) => v === 'audit-integrity-process-lock-unavailable').length,
      1,
    );

    // Coordinated suites still pin current closed-set (not prior/next)
    const ecTest = await readText(PATHS.errorCodesTest);
    const adm = await readText(PATHS.admissionScans);
    assert.ok(
      findStructuralClosedSetLengthLocks(ecTest, cur).length >= 1
        || ecTest.includes('Object.keys(ERROR_CODES).length'),
      'error-codes test references registry length',
    );
    assert.ok(
      findStructuralClosedSetLengthLocks(adm, cur).length >= 1
        || /currentClosedSetCount/.test(adm)
        || new RegExp(String(cur)).test(adm),
      'admission scans aware of current closed-set',
    );

    const self = await readText(PATHS.scanSelf);
    assert.deepEqual(
      findStructuralClosedSetLengthLocks(self, prior),
      [],
      `scan self must not pin prior closed-set ${prior}`,
    );
    assert.deepEqual(
      findStructuralClosedSetLengthLocks(self, next),
      [],
      `scan self must not pin future closed-set ${next}`,
    );

    const regSrc = await readText(PATHS.errorCodes);
    assert.ok(
      /\bAUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE\b/.test(maskJsNonCode(regSrc)),
      'registry defines process-lock key',
    );
  });
});

describe('C4 S8: scan-root boundary + path-free diagnostics', () => {
  it('S8. all PATHS under repo src/docs/test (or root package/readme); labels only', async () => {
    for (const [label, abs] of Object.entries(PATHS)) {
      assert.ok(
        pathUnderAllowedRoot(abs) || resolve(abs).startsWith(`${REPO_ROOT}/`),
        `path label ${label} outside allowed roots`,
      );
      // Root-level package.json / README are explicit truth surfaces
      if (label === 'packageJson' || label === 'readme') {
        assert.equal(basename(abs), label === 'readme' ? 'README.md' : 'package.json');
      } else {
        assert.ok(
          resolve(abs).startsWith(`${SRC_DIR}/`)
            || resolve(abs).startsWith(`${DOCS_DIR}/`)
            || resolve(abs).startsWith(`${TEST_DIR}/`)
            || resolve(abs) === resolve(__filename),
          `label ${label} not under src/docs/test`,
        );
      }
    }

    await withTempRoot('mut', async (root) => {
      const f = join(root, 'fixture.js');
      await writeFile(f, `import { x } from '${PROCESS_LOCK_SPEC}';\n`, 'utf8');
      const text = await readFile(f, 'utf8');
      assert.ok(staticImportsProcessLockModule(text));
      assert.equal(basename(f), 'fixture.js');
    });
  });
});

describe('C4 S9: process-lock / queue import graph cold import smoke', () => {
  it('S9. queue exports only enqueue+assert; lock error path-free fixed code', async () => {
    const queueMod = await import('../src/audit-integrity-write-queue.js');
    assert.deepEqual(
      Object.keys(queueMod).sort(),
      ['assertAuditIntegrityWriteLease', 'enqueueAuditIntegrityWriteTask'],
    );
    assert.equal(queueMod[ACQUIRE_API], undefined);
    assert.equal(queueMod[RELEASE_API], undefined);

    const lockMod = await import('../src/audit-integrity-process-lock.js');
    const err = new lockMod.AuditIntegrityProcessLockError();
    assert.equal(err.code, ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE);
    assert.equal(err.message, err.code);
    assert.equal(err.message.includes('/'), false);
  });
});
