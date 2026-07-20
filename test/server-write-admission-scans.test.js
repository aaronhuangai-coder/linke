/**
 * V1.39 C3 — write-admission scans / honesty / closed-set 61.
 *
 * Static honesty gates for pre-side-effect required admission:
 *   server central gate + required helper remap+throw
 *   agent required NAS start (not best-effort swallow helper)
 *   post-outcome best-effort honesty retained
 *   ERROR_CODES closed-set 61; current test tree 60-locks cleared
 *
 * Reads explicit allowlisted production paths + recursive test/ *.js for
 * current closed-set locks. No git. No secret dirs.
 *
 * Signature ceiling (docs/C4 only; this suite does not claim delivery):
 *   V1.39 safety-critical audit write-admission fail-closed implementation
 * Not T6d.3 complete / M6d Exit / production-hardening ready /
 * end-to-end production audit delivery / post-outcome durability /
 * atomic business+audit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const TEST_ROOT = join(REPO_ROOT, 'test');

const PATHS = Object.freeze({
  server: join(REPO_ROOT, 'src/server.js'),
  agent: join(REPO_ROOT, 'src/agent.js'),
  errorCodes: join(REPO_ROOT, 'src/error-codes.js'),
  monitor: join(REPO_ROOT, 'src/audit-integrity-monitor.js'),
  scanSelf: __filename,
});

/** Frozen production names (real identifiers — not assembled). */
const REQUIRED_HELPER = 'recordRequiredWriteAdmissionAudit';
const BEST_EFFORT_SERVER = 'recordAudit';
const REQUIRED_NAS_HELPER = 'recordRequiredNasReplicationStartAudit';
const BEST_EFFORT_NAS = 'appendNasReplicationAudit';
const ADMISSION_TYPE = 'api.write.admission.started';

/** Stale closed-set digit pair assembled at runtime so this file never holds a contiguous lock. */
function staleClosedSetCount() {
  return Number(['6', '0'].join(''));
}

function currentClosedSetCount() {
  return Number(['6', '1'].join(''));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isJsIdentPart(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Minimal JS lexical mask for scan honesty.
 * Preserves length and newlines; non-code becomes spaces.
 * Masks line/block comments, ' / " strings, template text, regex literals.
 * Template ${expressions} remain code.
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

/**
 * Mask comments only; keep string literals visible for type/event scans.
 */
function maskJsCommentsOnly(source) {
  const s = String(source);
  const n = s.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = s[i];
  let i = 0;

  function maskChar(idx) {
    if (s[idx] !== '\n' && s[idx] !== '\r') out[idx] = ' ';
  }

  while (i < n) {
    const ch = s[i];
    const next = i + 1 < n ? s[i + 1] : '';

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
      i += 1;
      while (i < n) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i += 1;
          break;
        }
        if (s[i] === '\n' || s[i] === '\r') break;
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < n) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === '`') {
          i += 1;
          break;
        }
        if (s[i] === '$' && i + 1 < n && s[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (s[i] === '{') depth += 1;
            else if (s[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function hasCallSite(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`);
  return re.test(maskJsNonCode(source));
}

function countCallSites(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  return (maskJsNonCode(source).match(re) || []).length;
}

function countAsyncFunctionDefs(source, name) {
  const re = new RegExp(
    `(?:export\\s+)?async\\s+function\\s+${escapeRegExp(name)}\\s*\\(`,
    'g',
  );
  return (maskJsNonCode(source).match(re) || []).length;
}

/**
 * Extract function body for `async function name(...) { ... }` or `function name(...) { ... }`
 * by brace balance on lexically masked source.
 */
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
 * Extract a top-level-ish `if (isApiWriteRoute(method, pathname)) { ... }` block body
 * starting at a masked index of `if`.
 */
function extractIfBlockBodyFrom(source, ifIndex) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  let i = ifIndex;
  // skip `if`
  i += 2;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  if (masked[i] !== '(') return null;
  let parenDepth = 0;
  for (; i < masked.length; i += 1) {
    if (masked[i] === '(') parenDepth += 1;
    else if (masked[i] === ')') {
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
    if (masked[j] === '{') depth += 1;
    else if (masked[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          body: text.slice(openBrace + 1, j),
          bodyStart: openBrace + 1,
          bodyEnd: j,
          ifIndex,
        };
      }
    }
  }
  return null;
}

/**
 * Find every real `if (isApiWriteRoute(method, pathname))` in source (code only).
 */
function findIsApiWriteRouteIfBlocks(source) {
  const masked = maskJsNonCode(source);
  const re = /\bif\s*\(\s*isApiWriteRoute\s*\(\s*method\s*,\s*pathname\s*\)\s*\)/g;
  const blocks = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    const block = extractIfBlockBodyFrom(source, m.index);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * First non-whitespace/comment statement of a block body (masked).
 * Returns the original slice of that statement start region (~200 chars).
 */
function firstStatementRegion(body, maxChars = 240) {
  const masked = maskJsNonCode(body);
  let i = 0;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  return {
    start: i,
    region: body.slice(i, i + maxChars),
    maskedRegion: masked.slice(i, i + maxChars),
  };
}

/**
 * Detect empty / comment-only catch swallow vs remap+throw.
 * Returns classification for the first catch in a function body.
 */
function classifyFirstCatch(functionBody) {
  const text = String(functionBody);
  const masked = maskJsNonCode(text);
  const catchRe = /\bcatch\b/g;
  const m = catchRe.exec(masked);
  if (!m) return { kind: 'no-catch', body: null };

  let i = m.index + m[0].length;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  // optional (binding)
  if (masked[i] === '(') {
    let depth = 0;
    for (; i < masked.length; i += 1) {
      if (masked[i] === '(') depth += 1;
      else if (masked[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
  }
  if (masked[i] !== '{') return { kind: 'malformed', body: null };
  const open = i;
  let depth = 0;
  let close = -1;
  for (let j = open; j < masked.length; j += 1) {
    if (masked[j] === '{') depth += 1;
    else if (masked[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = j;
        break;
      }
    }
  }
  if (close < 0) return { kind: 'malformed', body: null };
  const catchBody = text.slice(open + 1, close);
  const catchMasked = maskJsNonCode(catchBody).trim();
  if (catchMasked.length === 0) {
    return { kind: 'swallow-empty', body: catchBody };
  }
  const hasThrow = /\bthrow\b/.test(catchMasked);
  const hasLinkeError = /\bLinkeError\b/.test(catchMasked);
  const hasCode = /\bAUDIT_DELIVERY_UNAVAILABLE\b/.test(catchMasked)
    || /ERROR_CODES\s*\.\s*AUDIT_DELIVERY_UNAVAILABLE/.test(catchMasked);
  const hasStatus503 = /statusCode\s*:\s*503/.test(catchMasked);
  const hasRetryableTrue = /retryable\s*:\s*true/.test(catchMasked);
  if (hasThrow && hasLinkeError && hasCode && hasStatus503 && hasRetryableTrue) {
    return { kind: 'remap-throw', body: catchBody };
  }
  if (hasThrow) return { kind: 'throw-other', body: catchBody };
  return { kind: 'swallow-nonempty', body: catchBody };
}

/**
 * Count string-literal occurrences of exact value (comment-masked source).
 */
function countStringLiteral(source, value) {
  const code = maskJsCommentsOnly(source);
  const re = new RegExp(`(['"])${escapeRegExp(value)}\\1`, 'g');
  return (code.match(re) || []).length;
}

/**
 * Narrative (title/comment) patterns for current closed-set locks equal to the
 * stale count. Built at runtime so this file never embeds a contiguous lock.
 * Applied line-by-line (titles are single-line by convention).
 */
function staleNarrativeLockPatterns() {
  const n = String(staleClosedSetCount());
  return [
    new RegExp(String.raw`\bexact\s+${n}\b`),
    new RegExp(String.raw`\bremains\s+${n}\b`),
    new RegExp(String.raw`\bclosed-set\s+${n}\b`),
    new RegExp(String.raw`\bexactly\s+${n}\b`),
    new RegExp(String.raw`\bcount\s+remains\s+${n}\b`),
    new RegExp(String.raw`\blength\s+is\s+exactly\s+${n}\b`),
    new RegExp(String.raw`\blength\s+remains\s+${n}\b`),
  ];
}

/**
 * Structural Object.keys(ERROR_CODES).length locks for a target count.
 * Patterns allow cross-line whitespace (equal / strictEqual / === / == forms).
 * Intended for use on maskJsNonCode output so comment/string fixtures do not match.
 */
function structuralClosedSetLengthPatterns(count) {
  const n = String(count);
  return [
    // assert.equal / assert.strictEqual(Object.keys(ERROR_CODES).length, N)
    new RegExp(
      String.raw`Object\.keys\(\s*ERROR_CODES\s*\)\.length\s*,\s*${n}\b`,
      'g',
    ),
    // Object.keys(ERROR_CODES).length === N  (or == N)
    new RegExp(
      String.raw`Object\.keys\(\s*ERROR_CODES\s*\)\.length\s*===\s*${n}\b`,
      'g',
    ),
    new RegExp(
      String.raw`Object\.keys\(\s*ERROR_CODES\s*\)\.length\s*==\s*${n}\b`,
      'g',
    ),
  ];
}

/** Line number (1-based) for a character index in source text. */
function indexToLineNumber(text, index) {
  let line = 1;
  const end = Math.min(Math.max(0, index), String(text).length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Code-aware structural scan for Object.keys(ERROR_CODES).length locks of `count`.
 * Uses maskJsNonCode so comment / string / template decoys cannot trip.
 * Cross-line whitespace between `.length` and the count is matched.
 * @returns {{ line: number, text: string, kind: 'structural' }[]}
 */
function findStructuralClosedSetLengthLocks(source, count) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const lines = text.split(/\r?\n/);
  const hits = [];
  const seen = new Set();
  for (const re of structuralClosedSetLengthPatterns(count)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const line = indexToLineNumber(text, m.index);
      const key = `${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        line,
        text: (lines[line - 1] || '').trim().slice(0, 160),
        kind: 'structural',
      });
    }
  }
  return hits;
}

/**
 * Line-local narrative stale locks (exact/remains/closed-set …).
 * @returns {{ line: number, text: string, kind: 'narrative' }[]}
 */
function findNarrativeStaleClosedSetLocks(source) {
  const patterns = staleNarrativeLockPatterns();
  const lines = String(source).split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const re of patterns) {
      re.lastIndex = 0;
      if (re.test(line)) {
        hits.push({
          line: i + 1,
          text: line.trim().slice(0, 160),
          kind: 'narrative',
        });
        break;
      }
    }
  }
  return hits;
}

/**
 * Combined stale lock finder for one source string (structural + narrative).
 * Structural uses stale count only — current closed-set count is never reported.
 */
function findStaleClosedSetLocksInSource(source) {
  const stale = staleClosedSetCount();
  const structural = findStructuralClosedSetLengthLocks(source, stale).map((h) => ({
    ...h,
    kind: 'structural',
  }));
  const narrative = findNarrativeStaleClosedSetLocks(source);
  // Dedupe same line (structural + narrative on one assert line).
  const byLine = new Map();
  for (const h of [...structural, ...narrative]) {
    if (!byLine.has(h.line)) byLine.set(h.line, h);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * Recursively list *.js under test/ (repo current files only).
 */
async function listTestJsFiles(root = TEST_ROOT) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        await walk(abs);
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * Find current stale closed-set locks across the whole test tree.
 * Only scans real repo files under test/ — never tmp hostile fixtures.
 * Structural locks are code-aware and cross-line; narrative remains line-local.
 * Does not catch-swallow — IO errors propagate.
 */
async function findStaleClosedSetLocksInTestTree() {
  const files = await listTestJsFiles(TEST_ROOT);
  const hits = [];
  for (const abs of files) {
    const text = await readFile(abs, 'utf8');
    const rel = relative(REPO_ROOT, abs);
    for (const h of findStaleClosedSetLocksInSource(text)) {
      hits.push({
        file: rel,
        line: h.line,
        text: h.text,
        kind: h.kind,
      });
    }
  }
  return hits;
}

async function readText(absPath) {
  return readFile(absPath, 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Hostile canaries for scan helpers (anti false-green)
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 A: scan helper hostile canaries (anti false-green)', () => {
  it('maskJsNonCode strips comment/string decoys; keeps real call sites', () => {
    const decoy = `
      // await recordRequiredWriteAdmissionAudit(x)
      const s = "recordRequiredWriteAdmissionAudit(";
      const t = \`recordRequiredWriteAdmissionAudit(\`;
      /* recordRequiredWriteAdmissionAudit(y) */
      await recordRequiredWriteAdmissionAudit(real);
    `;
    assert.equal(countCallSites(decoy, REQUIRED_HELPER), 1);
    assert.equal(hasCallSite(decoy, REQUIRED_HELPER), true);

    const onlyComment = `
      // async function recordRequiredWriteAdmissionAudit() {}
      const x = 'async function recordRequiredWriteAdmissionAudit() {}';
    `;
    assert.equal(countAsyncFunctionDefs(onlyComment, REQUIRED_HELPER), 0);
    assert.equal(countCallSites(onlyComment, REQUIRED_HELPER), 0);
  });

  it('extractFunctionBody ignores default-param {} / string braces / comment braces', () => {
    const src = `
      async function sampleDefault(opts = { a: 1 }) {
        await appendAuditEvent(opts);
        return true;
      }
      async function sampleBraces() {
        const s = "{ not a brace }";
        /* { comment brace } */
        await appendAuditEvent(s);
      }
    `;
    const d = extractFunctionBody(src, 'sampleDefault');
    assert.ok(d != null);
    assert.ok(hasCallSite(d, 'appendAuditEvent'));
    const b = extractFunctionBody(src, 'sampleBraces');
    assert.ok(b != null);
    assert.ok(hasCallSite(b, 'appendAuditEvent'));
    assert.equal(extractFunctionBody(src, 'missing'), null);
  });

  it('classifyFirstCatch distinguishes swallow vs remap-throw; decoys cannot remap-green', () => {
    const swallowEmpty = `
      try { await appendAuditEvent(x); } catch { }
    `;
    assert.equal(classifyFirstCatch(swallowEmpty).kind, 'swallow-empty');

    const swallowComment = `
      try { await appendAuditEvent(x); } catch {
        // ignore audit I/O failures
      }
    `;
    assert.equal(classifyFirstCatch(swallowComment).kind, 'swallow-empty');

    const swallowLog = `
      try { await appendAuditEvent(x); } catch (err) {
        console.error('Audit log write failed:', err.message);
      }
    `;
    assert.equal(classifyFirstCatch(swallowLog).kind, 'swallow-nonempty');

    const remap = `
      try { await appendAuditEvent(x); } catch {
        throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, {
          statusCode: 503,
          retryable: true,
        });
      }
    `;
    assert.equal(classifyFirstCatch(remap).kind, 'remap-throw');

    // Comment-only "throw new LinkeError" must not false-green as remap.
    const commentThrow = `
      try { await appendAuditEvent(x); } catch {
        // throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, { statusCode: 503, retryable: true });
      }
    `;
    assert.equal(classifyFirstCatch(commentThrow).kind, 'swallow-empty');

    // Missing statusCode/retryable is not remap-throw.
    const partial = `
      try { await appendAuditEvent(x); } catch {
        throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
      }
    `;
    assert.equal(classifyFirstCatch(partial).kind, 'throw-other');
  });

  it('findIsApiWriteRouteIfBlocks separates admission gate from auth.forbidden decoy', () => {
    const src = `
      if (!isWriteAllowed) {
        if (isApiWriteRoute(method, pathname)) {
          await recordAudit(dataDir, { type: 'auth.forbidden' });
          return sendError(res, 403, 'Forbidden');
        }
      }
      if (isApiWriteRoute(method, pathname)) {
        await recordRequiredWriteAdmissionAudit(dataDir, { method, path: pathname, requestId }, retention);
      }
      if (isExactApiRoute(url, method, 'POST', '/api/device-enrollment-codes')) {
        body = await readBody(req);
      }
    `;
    const blocks = findIsApiWriteRouteIfBlocks(src);
    assert.equal(blocks.length, 2);
    const admission = blocks.filter((b) => hasCallSite(b.body, REQUIRED_HELPER));
    const forbidden = blocks.filter((b) => /auth\.forbidden/.test(maskJsCommentsOnly(b.body)));
    assert.equal(admission.length, 1);
    assert.equal(forbidden.length, 1);
    const first = firstStatementRegion(admission[0].body);
    assert.ok(
      /^\s*await\s+recordRequiredWriteAdmissionAudit\s*\(/.test(first.maskedRegion)
      || hasCallSite(first.region, REQUIRED_HELPER),
    );
  });

  it('countStringLiteral ignores comment-only type decoys', () => {
    const decoy = `
      // type: 'api.write.admission.started'
      /* 'api.write.admission.started' */
      const dead = true;
    `;
    assert.equal(countStringLiteral(decoy, ADMISSION_TYPE), 0);

    const real = `
      await appendAuditEvent(dataDir, {
        type: 'api.write.admission.started',
        method,
      });
    `;
    assert.equal(countStringLiteral(real, ADMISSION_TYPE), 1);
  });

  it('stale lock patterns match real assert locks; dynamic self source does not self-trip', async () => {
    const n = staleClosedSetCount();
    const fixture = [
      `assert.equal(Object.keys(ERROR_CODES).length, ${n});`,
      `assert.equal(Object.keys(ERROR_CODES).length === ${n}, true);`,
      `it('${['exact', n].join(' ')} registry', () => {});`,
      `// closed-set ${n}`,
      `// remains ${n}`,
    ].join('\n');
    const hits = findStaleClosedSetLocksInSource(fixture);
    assert.ok(hits.length >= 4, `fixture must trip patterns, got ${hits.length}`);

    // This scan file itself must not contain a contiguous stale lock (narrative or structural).
    const self = await readText(PATHS.scanSelf);
    const selfHits = findStaleClosedSetLocksInSource(self);
    assert.deepEqual(
      selfHits,
      [],
      `scan self must not self-trip stale locks: ${JSON.stringify(selfHits)}`,
    );
  });

  it('structural scan catches cross-line stale assert; current-count and decoys do not', () => {
    const n = staleClosedSetCount();
    const cur = currentClosedSetCount();

    // Runtime-assembled cross-line stale equal / strictEqual — must be detected.
    const crossEqual = [
      'assert.equal(Object.keys(ERROR_CODES).length,',
      `  ${n});`,
    ].join('\n');
    const crossStrict = [
      'assert.strictEqual(',
      '  Object.keys(ERROR_CODES).length,',
      `  ${n}`,
      ');',
    ].join('\n');
    const crossEqEq = [
      'if (Object.keys(ERROR_CODES).length ===',
      `    ${n}) throw new Error('stale');`,
    ].join('\n');

    const eqHits = findStructuralClosedSetLengthLocks(crossEqual, n);
    assert.ok(eqHits.length >= 1, 'cross-line equal must trip structural scan');
    assert.equal(eqHits[0].kind, 'structural');

    const strictHits = findStructuralClosedSetLengthLocks(crossStrict, n);
    assert.ok(strictHits.length >= 1, 'cross-line strictEqual must trip');

    const eqEqHits = findStructuralClosedSetLengthLocks(crossEqEq, n);
    assert.ok(eqEqHits.length >= 1, 'cross-line === must trip');

    // Combined finder also sees them (and may add narrative if titles present).
    assert.ok(findStaleClosedSetLocksInSource(crossEqual).length >= 1);
    assert.ok(findStaleClosedSetLocksInSource(crossStrict).length >= 1);

    // Current closed-set count cross-line must NOT be reported as stale.
    const currentCross = [
      'assert.equal(Object.keys(ERROR_CODES).length,',
      `  ${cur});`,
    ].join('\n');
    assert.deepEqual(
      findStructuralClosedSetLengthLocks(currentCross, n),
      [],
      'current closed-set cross-line must not be stale',
    );
    assert.deepEqual(findStaleClosedSetLocksInSource(currentCross), []);

    // Comment / string decoys must not trip code-aware structural scan.
    const decoy = [
      `// assert.equal(Object.keys(ERROR_CODES).length,`,
      `//   ${n});`,
      `/* Object.keys(ERROR_CODES).length === ${n} */`,
      `const s = "Object.keys(ERROR_CODES).length, ${n}";`,
      'const t = `Object.keys(ERROR_CODES).length === ' + n + '`;',
    ].join('\n');
    assert.deepEqual(
      findStructuralClosedSetLengthLocks(decoy, n),
      [],
      'comment/string decoys must not trip structural scan',
    );
    // Narrative patterns still see "exact N" style only when written as bare narrative —
    // decoy above has no exact/remains title; combined should stay empty for structural side.
    assert.equal(
      findStaleClosedSetLocksInSource(decoy).filter((h) => h.kind === 'structural').length,
      0,
    );
  });

  it('hostile tmp fixture outside test/ is not treated as repo current lock', async () => {
    const n = staleClosedSetCount();
    const root = await mkdtemp(join(tmpdir(), 'linke-c3-hostile-'));
    try {
      const hostile = join(root, 'fake-lock.test.js');
      // Cross-line form in tmp — still outside test/, so tree scan must ignore it.
      await writeFile(
        hostile,
        [
          'assert.equal(Object.keys(ERROR_CODES).length,',
          `  ${n});`,
          '',
        ].join('\n'),
        'utf8',
      );
      const hits = await findStaleClosedSetLocksInTestTree();
      assert.equal(
        hits.some((h) => h.file.includes('fake-lock')),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S1 — required helper exact-one def + exact-one awaited production call
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S1: recordRequiredWriteAdmissionAudit exact-one def + awaited call', () => {
  it('S1. async function def exact-one; name( sites total 2 (def+call); dead helper forbidden', async () => {
    const server = await readText(PATHS.server);
    assert.equal(
      countAsyncFunctionDefs(server, REQUIRED_HELPER),
      1,
      'exact-one async function definition',
    );
    // definition `function name(` + production call `name(` = 2
    assert.equal(
      countCallSites(server, REQUIRED_HELPER),
      2,
      'definition + production call total 2 (no dead helper / no extra call)',
    );
    const body = extractFunctionBody(server, REQUIRED_HELPER);
    assert.ok(body != null, 'must extract real function body');
    // Must be truly awaited at the gate (not fire-and-forget).
    const masked = maskJsNonCode(server);
    assert.ok(
      new RegExp(`\\bawait\\s+${escapeRegExp(REQUIRED_HELPER)}\\s*\\(`).test(masked),
      'production call must be awaited',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S2 — helper body: direct appendAuditEvent; catch remap+throw only
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S2: required helper body appendAuditEvent + remap throw (no swallow)', () => {
  it('S2. body calls appendAuditEvent; no .catch(; catch is remap+throw LinkeError 503', async () => {
    const server = await readText(PATHS.server);
    const body = extractFunctionBody(server, REQUIRED_HELPER);
    assert.ok(body != null);
    assert.ok(hasCallSite(body, 'appendAuditEvent'), 'must call appendAuditEvent directly');
    assert.equal(hasCallSite(body, BEST_EFFORT_SERVER), false, 'must not route via recordAudit');
    const bodyMasked = maskJsNonCode(body);
    assert.equal(/\.catch\s*\(/.test(bodyMasked), false, 'no promise .catch(');
    const cls = classifyFirstCatch(body);
    assert.equal(cls.kind, 'remap-throw', `catch must remap+throw, got ${cls.kind}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S3 — central gate order: after rate/auth, before readBody / write handlers
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S3: central isApiWriteRoute gate order and first-statement await', () => {
  it('S3. admission if-block first stmt awaits helper; after auth/rate; before readBody/write route', async () => {
    const server = await readText(PATHS.server);
    const blocks = findIsApiWriteRouteIfBlocks(server);
    assert.ok(blocks.length >= 2, 'expect auth.forbidden if + central gate if');

    const admissionBlocks = blocks.filter((b) => hasCallSite(b.body, REQUIRED_HELPER));
    assert.equal(admissionBlocks.length, 1, 'exact-one admission gate block');
    const gate = admissionBlocks[0];

    // Must not be the auth.forbidden twin.
    assert.equal(
      /auth\.forbidden/.test(maskJsCommentsOnly(gate.body)),
      false,
      'admission gate must not be the auth.forbidden block',
    );

    const first = firstStatementRegion(gate.body);
    const firstMasked = first.maskedRegion;
    assert.ok(
      new RegExp(`^\\s*await\\s+${escapeRegExp(REQUIRED_HELPER)}\\s*\\(`).test(firstMasked),
      `first statement must be await ${REQUIRED_HELPER}(...); got: ${first.region.slice(0, 120)}`,
    );

    // Lexical order: identifiers via full mask; event-type strings via comments-only mask
    // (string bodies are blanked by maskJsNonCode and would false-miss auth.* types).
    const masked = maskJsNonCode(server);
    const codeWithStrings = maskJsCommentsOnly(server);
    const gatePos = gate.ifIndex;
    const ratePos = masked.search(/\bapiRateLimiter\b/);
    const authDeniedPos = codeWithStrings.search(
      /(['"])auth\.denied\1/,
    );
    // auth.forbidden appears inside the earlier isApiWriteRoute if — use that block.
    const forbiddenBlocks = blocks.filter((b) => /auth\.forbidden/.test(maskJsCommentsOnly(b.body)));
    assert.equal(forbiddenBlocks.length, 1);
    const forbiddenPos = forbiddenBlocks[0].ifIndex;

    assert.ok(ratePos >= 0, 'rate-limit block present');
    assert.ok(authDeniedPos >= 0, 'auth.denied present');
    assert.ok(gatePos > ratePos, 'gate after rate-limit');
    assert.ok(gatePos > authDeniedPos, 'gate after auth.denied');
    assert.ok(gatePos > forbiddenPos, 'gate after auth.forbidden isApiWriteRoute if');

    // First write-route handler / awaited readBody after gate.
    // Use `await readBody` so the earlier function *definition* is not mistaken for a call.
    const afterGate = masked.slice(gate.bodyEnd);
    const readBodyRel = afterGate.search(/\bawait\s+readBody\s*\(/);
    assert.ok(readBodyRel >= 0, 'await readBody exists after gate');
    // device-enrollment is the first write route in production order.
    const afterGateStrings = codeWithStrings.slice(gate.bodyEnd);
    const firstWriteRel = afterGateStrings.search(/\/api\/device-enrollment-codes/);
    assert.ok(firstWriteRel >= 0, 'first write route handler after gate');

    // First awaited readBody in the whole request handler must sit after the central gate.
    const firstAwaitReadBodyAbs = masked.search(/\bawait\s+readBody\s*\(/);
    assert.ok(firstAwaitReadBodyAbs > gatePos, 'first await readBody must be after central gate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S4 — admission event type unique in production (real string, not comment)
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S4: api.write.admission.started production unique real string', () => {
  it('S4. type string exact-one in server; lives inside required helper body', async () => {
    const server = await readText(PATHS.server);
    assert.equal(
      countStringLiteral(server, ADMISSION_TYPE),
      1,
      'production unique admission type string',
    );
    const body = extractFunctionBody(server, REQUIRED_HELPER);
    assert.ok(body != null);
    assert.equal(countStringLiteral(body, ADMISSION_TYPE), 1);
    // Must be a type: '...' property, not a free-floating decoy identifier.
    assert.ok(
      new RegExp(
        String.raw`\btype\s*:\s*(['"])${escapeRegExp(ADMISSION_TYPE)}\1`,
      ).test(maskJsCommentsOnly(body)),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S5 — recordAudit remains best-effort catch (post honesty)
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S5: recordAudit still best-effort catch (post honesty)', () => {
  it('S5. recordAudit exists; catch swallows (no rethrow); still calls appendAuditEvent', async () => {
    const server = await readText(PATHS.server);
    const body = extractFunctionBody(server, BEST_EFFORT_SERVER);
    assert.ok(body != null, 'recordAudit must remain a real function');
    assert.ok(hasCallSite(body, 'appendAuditEvent'));
    const cls = classifyFirstCatch(body);
    assert.ok(
      cls.kind === 'swallow-empty' || cls.kind === 'swallow-nonempty',
      `recordAudit catch must swallow, got ${cls.kind}`,
    );
    assert.notEqual(cls.kind, 'remap-throw', 'must not convert post audit to required');
    assert.notEqual(cls.kind, 'no-catch', 'must keep catch (honest best-effort)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S6 — appendNasReplicationAudit swallow; required NAS helper bypasses it
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S6: NAS best-effort swallow retained; required helper direct append', () => {
  it('S6. appendNasReplicationAudit catch-swallow; required NAS helper does not call it', async () => {
    const agent = await readText(PATHS.agent);
    const best = extractFunctionBody(agent, BEST_EFFORT_NAS);
    assert.ok(best != null, 'appendNasReplicationAudit must remain');
    assert.ok(hasCallSite(best, 'appendAuditEvent'));
    const bestCatch = classifyFirstCatch(best);
    assert.ok(
      bestCatch.kind === 'swallow-empty' || bestCatch.kind === 'swallow-nonempty',
      `NAS best-effort must swallow, got ${bestCatch.kind}`,
    );

    const required = extractFunctionBody(agent, REQUIRED_NAS_HELPER);
    assert.ok(required != null, 'required NAS helper must exist');
    assert.ok(hasCallSite(required, 'appendAuditEvent'));
    assert.equal(
      hasCallSite(required, BEST_EFFORT_NAS),
      false,
      'required NAS helper must not call swallow helper',
    );
    const reqCatch = classifyFirstCatch(required);
    assert.equal(reqCatch.kind, 'remap-throw');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S7 — structural anti-OR / anti soft-catch covered by A canaries + production
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S7: production scans reject comment/string/decoy (wired via helpers)', () => {
  it('S7. production server/agent real bodies; not comment-only shells', async () => {
    const server = await readText(PATHS.server);
    const agent = await readText(PATHS.agent);
    // Dead decoy after real def would bump call-site count — already S1 exact-2.
    assert.equal(countCallSites(server, REQUIRED_HELPER), 2);
    // Required NAS: def + execute-path await = 2 name( sites.
    assert.equal(countAsyncFunctionDefs(agent, REQUIRED_NAS_HELPER), 1);
    assert.equal(countCallSites(agent, REQUIRED_NAS_HELPER), 2);
    assert.ok(
      new RegExp(`\\bawait\\s+${escapeRegExp(REQUIRED_NAS_HELPER)}\\s*\\(`).test(
        maskJsNonCode(agent),
      ),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S8 — closed-set 61 runtime + full test tree current 60 locks = 0
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S8: ERROR_CODES length 61; full test/ tree stale 60 locks cleared', () => {
  it('S8a. runtime Object.keys(ERROR_CODES).length === 61 (import real registry)', () => {
    assert.equal(Object.keys(ERROR_CODES).length, currentClosedSetCount());
  });

  it('S8b. recursive test/**/*.js current stale closed-set locks are zero', async () => {
    const hits = await findStaleClosedSetLocksInTestTree();
    assert.deepEqual(
      hits,
      [],
      hits.length
        ? `stale closed-set locks remain:\n${hits
          .map((h) => `  ${h.file}:${h.line}: ${h.text}`)
          .join('\n')}`
        : '',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S9 — AUDIT_DELIVERY_UNAVAILABLE unique V1.39 code; registry exact 61
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S9: AUDIT_DELIVERY_UNAVAILABLE unique new code; registry exact 61', () => {
  it('S9. real ERROR_CODES import; exact 61; unique delivery code; value precise', async () => {
    assert.equal(Object.keys(ERROR_CODES).length, currentClosedSetCount());
    assert.equal(
      ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE,
      'audit-delivery-unavailable',
    );
    // Unique among values — no second delivery-like code.
    const deliveryValues = Object.values(ERROR_CODES).filter((v) =>
      String(v).includes('delivery'));
    assert.deepEqual(deliveryValues, ['audit-delivery-unavailable']);

    // Source registry must define exact-one key (not a second new code adjacent).
    const src = await readText(PATHS.errorCodes);
    const masked = maskJsNonCode(src);
    assert.equal(
      (masked.match(/\bAUDIT_DELIVERY_UNAVAILABLE\b/g) || []).length,
      1,
    );
    // Value string exact-one in registry source.
    assert.equal(countStringLiteral(src, 'audit-delivery-unavailable'), 1);

    // Keys frozen object — no duplicate values.
    const values = Object.values(ERROR_CODES);
    assert.equal(new Set(values).size, values.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S10 — V1.38 monitor contract frozen (source honesty; full tests in GREEN cmd)
// ═══════════════════════════════════════════════════════════════════════════

describe('C3 S10: V1.38 monitor source contract frozen (10-key / exit / zero-write)', () => {
  it('S10. exit helper body healthy→0 alert→2 no return 1; zero-write; no error-codes; no setInterval', async () => {
    const monitor = await readText(PATHS.monitor);
    const masked = maskJsNonCode(monitor);

    // Real exported exit helper — not a wide OR on bare "status" / "exitCode" tokens.
    const exitBody = extractFunctionBody(monitor, 'auditIntegrityMonitorExitCode');
    assert.ok(
      exitBody != null,
      'export function auditIntegrityMonitorExitCode must extract',
    );
    const exitCode = maskJsNonCode(exitBody);
    const exitWithStrings = maskJsCommentsOnly(exitBody);
    // healthy → return 0
    assert.ok(
      /\.status\s*===\s*(['"])healthy\1/.test(exitWithStrings),
      'exit body must compare status === healthy',
    );
    assert.ok(
      /\breturn\s+0\b/.test(exitCode),
      'exit body must return 0 for healthy',
    );
    // alert → return 2
    assert.ok(
      /\.status\s*===\s*(['"])alert\1/.test(exitWithStrings),
      'exit body must compare status === alert',
    );
    assert.ok(
      /\breturn\s+2\b/.test(exitCode),
      'exit body must return 2 for alert',
    );
    // argv/program error exit 1 is outside this helper — body must not return 1.
    assert.equal(
      /\breturn\s+1\b/.test(exitCode),
      false,
      'auditIntegrityMonitorExitCode must not return 1',
    );

    // Zero-write callees (monitor must not gain mutators).
    for (const bad of [
      'safeAtomicWriteFile',
      'safeAtomicWriteText',
      'safeAtomicWriteJson',
      'safeAppendFile',
      'publishDualWriteStateUnlocked',
      'recoverAuditIntegrityDualWrite',
      'bootstrapAuditIntegrity',
    ]) {
      assert.equal(hasCallSite(monitor, bad), false, `monitor must not call ${bad}`);
    }

    // Still does not import error-codes (V1.38 isolation).
    assert.equal(
      /\berror-codes\.js\b/.test(masked),
      false,
    );

    // No setInterval scheduler.
    assert.equal(/\bsetInterval\b/.test(masked), false);
  });
});
