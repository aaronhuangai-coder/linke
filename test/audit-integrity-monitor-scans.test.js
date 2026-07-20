/**
 * V1.38 C4 — hostile scans / honesty / concurrency / zero-write
 * for the read-only audit integrity run-once monitor.
 *
 * Reads only explicit allowlisted paths (import.meta.url → repo root).
 * No recursive secret/env dirs. Forbidden capability compound is assembled
 * at runtime so this file does not self-trip.
 *
 * Signature ceiling (exact; may appear in C0 docs; C5 not yet required on source):
 *   V1.38 read-only audit integrity run-once monitor/alert implementation
 * Not T6d.3 complete / M6d Exit / production-hardening ready /
 * remote alert delivered / production monitoring ready /
 * multi-process exclusive lock as delivered claims.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';
import { SafeDataFileError } from '../src/safe-data-files.js';
import { stringifyStrictCanonicalSanitizedEvent } from '../src/audit-event-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

/** Explicit allowlisted paths only — never recursive secret dirs. */
const PATHS = Object.freeze({
  monitor: join(REPO_ROOT, 'src/audit-integrity-monitor.js'),
  dualWrite: join(REPO_ROOT, 'src/audit-integrity-dual-write.js'),
  writeQueue: join(REPO_ROOT, 'src/audit-integrity-write-queue.js'),
  agent: join(REPO_ROOT, 'src/agent.js'),
  server: join(REPO_ROOT, 'src/server.js'),
  webApp: join(REPO_ROOT, 'src/web/app.js'),
  webIndex: join(REPO_ROOT, 'src/web/index.html'),
  webStyles: join(REPO_ROOT, 'src/web/styles.css'),
  errorCodes: join(REPO_ROOT, 'src/error-codes.js'),
  c1Inspect: join(REPO_ROOT, 'test/audit-integrity-dual-write-readonly-inspect.test.js'),
  c2Monitor: join(REPO_ROOT, 'test/audit-integrity-monitor.test.js'),
  c3Agent: join(REPO_ROOT, 'test/agent-audit-integrity-monitor.test.js'),
  c4Scan: join(REPO_ROOT, 'test/audit-integrity-monitor-scans.test.js'),
  dualWriteScans: join(REPO_ROOT, 'test/audit-integrity-dual-write-scans.test.js'),
  monitorDesign: join(
    REPO_ROOT,
    'docs/superpowers/specs/2026-07-19-audit-integrity-monitor-alert-design.md',
  ),
  monitorPlan: join(
    REPO_ROOT,
    'docs/superpowers/plans/2026-07-19-audit-integrity-monitor-alert.md',
  ),
});

/** Segmented so this suite does not multi-count a single adjacent ceiling literal. */
const SIGNATURE_CEILING = [
  'V1.38 read-only audit integrity run-once monitor',
  '/alert implementation',
].join('');

const HONESTY_PHRASES = Object.freeze([
  'T6d.3 complete',
  'M6d Exit',
  'production-hardening ready',
  'remote alert delivered',
  'production monitoring ready',
  'multi-process exclusive lock',
]);

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

const EVENT_B = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-07-19T00:00:01.000Z',
  type: 'api.test',
  method: 'GET',
  path: '/api/other',
  outcome: 'success',
});

const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const HEALTHY_RELS = new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]);

const WRITE_CALLEES = Object.freeze([
  'safeAtomicWriteFile',
  'safeAtomicWriteText',
  'safeAtomicWriteJson',
  'safeAppendFile',
  'safeAppendText',
  'safeCreateExclusive',
  'publishDualWriteStateUnlocked',
  'publishDualWrite',
  'bootstrapAuditIntegrity',
  'bootstrap',
  'recoverAuditIntegrityDualWrite',
  'recoverAndValidateAuditIntegrityDualWrite',
  'recoverAudit',
  'writeFile',
  'appendFile',
  'mkdir',
  'unlink',
  'rename',
]);

const FORBIDDEN_MONITOR_IMPORT_NEEDLES = Object.freeze([
  'audit-log',
  'server',
  'agent',
  'write-queue',
  'dual-write-state',
  'journal',
  'cross-store',
  'error-codes',
  'safe-data-files',
]);

// ── honesty / lexical helpers (hostile-scan grade) ───────────────────────

const HONESTY_CLAUSE_SPLIT_RE = /[;；。,，—]|--|\.(?=\s)/;

function clauseHasNegativeOrBlockedContext(clause) {
  return (
    /\bBLOCKED\b/i.test(clause)
    || /\bFORBIDDEN\b/i.test(clause)
    || /\bNo\b/.test(clause)
    || /\bNot\b/.test(clause)
    || /\bno\b/i.test(clause)
    || /\bwithout\b/i.test(clause)
    || /\bmissing\b/i.test(clause)
    || /禁止|未|不是|不|否|严禁|仍无/.test(clause)
    || /\bdo not\b/i.test(clause)
    || /\bdoes not\b/i.test(clause)
    || /\bmust not\b/i.test(clause)
    || /\bnever\b/i.test(clause)
    || /\bnot\b/i.test(clause)
    // Note: bare "limitation" / "partial only" / "still partial" are NOT negative shields.
    // True negatives must use Not/no/未/不/仍无/BLOCKED etc. on the same clause.
    // Design table cells with 无 / 仍无 / 否 — NOT bare "as delivered" (that was a false-green escape).
    || /\|\s*无\s*\|/.test(clause)
    || /\*\*仍无\*\*/.test(clause)
    || /\*\*否\*\*/.test(clause)
    || /不实现/.test(clause)
    || /明确禁止/.test(clause)
    || /rejected/i.test(clause)
    || /\bREJECTED\b/i.test(clause)
    // Design candidate tables: "先做 multi-process lock" names a rejected option, not delivery.
    || /先做\s+multi-process/i.test(clause)
  );
}

function isMarkdownHeadingLine(line) {
  return /^#{1,6}\s+\S/.test(String(line).trim());
}

function isBlockedInventoryBullet(line) {
  return (
    /^\s*\*\s+-\s/.test(line)
    || /^\s*-\s+\S/.test(line)
    || /^\s*\d+\.\s+\S/.test(line)
    // Plan PM freeze: indented `| a | b |` continuation under NOT =
    || /^\s+\|/.test(line)
  );
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
  // Design/plan forbid inventories (not positive delivery).
  if (/\bFORBIDDEN\b/i.test(body)) return true;
  if (/明确不实现/.test(body) || /不实现清单/.test(body)) return true;
  if (/明确不防|不宣称/.test(body)) return true;
  if (/^REJECTED\b/i.test(body)) return true;
  // Plan freeze block: NOT = ... (multi-line pipe list)
  if (/^NOT\s*=/.test(body) || /^\s*NOT\s*=/.test(body)) return true;
  return false;
}

/**
 * Returns offenders where `phrase` appears without BLOCKED/negative context.
 * Context is clause-local, plus multi-line BLOCKED/FORBIDDEN/不实现 inventories.
 * Early "Not" never covers a later positive clause.
 * Blank lines inside an inventory do not end it (markdown list after heading).
 */
function findUnqualifiedHonestyPhraseLines(text, phrase) {
  const offenders = [];
  const lines = String(text).split(/\r?\n/);
  let inBlockedInventory = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (isBlockedInventoryHeader(line)) {
      inBlockedInventory = true;
    }

    const isInheritedBullet = inBlockedInventory && isBlockedInventoryBullet(line);

    if (inBlockedInventory) {
      if (isBlankOrDecorativeStarLine(line)) {
        // keep inventory open across blank lines inside forbid lists
      } else if (isMarkdownHeadingLine(line) && !isBlockedInventoryHeader(line)) {
        // New markdown section ends inventory (must not shelter later positive bullets).
        inBlockedInventory = false;
      } else if (!isBlockedInventoryBullet(line) && !isBlockedInventoryHeader(line)) {
        // non-bullet content ends inventory (e.g. next prose)
        inBlockedInventory = false;
      }
    }

    // Re-apply header after possible end so header line itself is inventory-start
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

/**
 * Advance FORBIDDEN/BLOCKED inventory state for one line (shared by honesty + signature).
 * @returns {{ inInventory: boolean, isInheritedBullet: boolean }}
 */
function advanceInventoryState(line, inInventory) {
  let next = inInventory;
  if (isBlockedInventoryHeader(line)) next = true;
  let isInheritedBullet = next && isBlockedInventoryBullet(line);
  if (next) {
    if (isBlankOrDecorativeStarLine(line)) {
      // keep open
    } else if (isMarkdownHeadingLine(line) && !isBlockedInventoryHeader(line)) {
      next = false;
      isInheritedBullet = false;
    } else if (!isBlockedInventoryBullet(line) && !isBlockedInventoryHeader(line)) {
      next = false;
      isInheritedBullet = false;
    }
  }
  if (isBlockedInventoryHeader(line)) next = true;
  return { inInventory: next, isInheritedBullet };
}

/**
 * Sole C0 plan meta title that may contain `implementation` without being a delivery signature.
 * Real allowlisted title:
 *   # V1.38 Read-Only Audit Integrity Run-Once Monitor/Alert Implementation Plan
 * Format-only flex: heading level (#…######), case, internal/edge whitespace.
 * Core words are fixed — `# V1.38 Production Monitoring Ready Implementation Plan` is NOT allowed.
 * Design title has no `implementation` token and needs no exemption.
 */
function isAllowedV138MetaDocTitleHeading(line) {
  const t = String(line).trim();
  return (
    /^#{1,6}\s+V1\.38\s+Read-Only\s+Audit\s+Integrity\s+Run-Once\s+Monitor\/Alert\s+Implementation\s+Plan\s*$/i
      .test(t)
  );
}

/**
 * Positive V1.38 … implementation signatures must be exactly SIGNATURE_CEILING.
 * Token `implementation` is matched case-insensitively.
 * Markdown headings are NOT blanket-exempt — only narrow meta doc title shapes.
 * Negative/BLOCKED/FORBIDDEN inventory / frozen-ceiling meta lines are allowed.
 * Clause-local: exact ceiling in clause A does not shelter a later competing clause.
 * @param {string} text
 * @returns {{ line: number, clause: string, text: string }[]}
 */
function findUnqualifiedV138SignatureLines(text) {
  const offenders = [];
  const lines = String(text).split(/\r?\n/);
  let inInventory = false;
  const implRe = /\bimplementation\b/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const advanced = advanceInventoryState(line, inInventory);
    inInventory = advanced.inInventory;
    if (advanced.isInheritedBullet) continue;
    if (!line.includes('V1.38') || !implRe.test(line)) continue;

    // Only the precise meta title form may skip the whole line (not arbitrary headings).
    if (isAllowedV138MetaDocTitleHeading(line)) continue;

    const clauses = line.split(HONESTY_CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (!clause.includes('V1.38') || !implRe.test(clause)) continue;
      // Exact frozen ceiling is the only allowed positive signature (case-sensitive string).
      if (clause.includes(SIGNATURE_CEILING)) continue;
      if (clauseHasNegativeOrBlockedContext(clause)) continue;
      // Meta documentation of the ceiling (not a competing delivery claim).
      if (
        /signature\s+ceiling|frozen.?ceiling|签字上限|ALLOWED signature|SIGNATURE\s*=/i.test(
          clause,
        )
      ) {
        continue;
      }
      offenders.push({ line: i + 1, clause, text: line });
    }
  }
  return offenders;
}

function assertNoUnqualifiedV138Signatures(text, label) {
  const offenders = findUnqualifiedV138SignatureLines(text);
  assert.equal(
    offenders.length,
    0,
    `${label}: unqualified V1.38 signature at ${offenders.map((o) => `L${o.line}:{${o.clause}}`).join(' | ')}`,
  );
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
 * and regex literals. Template `${expressions}` remain code.
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
    if (from) {
      specs.push(from[2]);
    }
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

function hasCallSite(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`);
  return re.test(maskJsNonCode(source));
}

function countCallSites(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  return (maskJsNonCode(source).match(re) || []).length;
}

/**
 * Opaque marker for computed / optional / indirect call callees (fail-closed).
 * Never appears in AGENT_MONITOR_CASE_CALL_ALLOWLIST.
 */
const NON_STATIC_CALL_CALLEE = '«non-static-callee»';

/** Keywords whose following `(` is not a value call (control / decl / unary). */
const PAREN_CONTROL_KEYWORDS = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'function',
  'with',
  'return',
  'typeof',
  'void',
  'await',
  'yield',
  'delete',
  'throw',
  'new',
]);

/**
 * Exact call-path multiset allowed in agent `audit-integrity-monitor` case body.
 * Counts are exact; any other path (network wrappers, fs, timers, recover, opaque) fails.
 * `new Error(...)` is recorded as path `Error`.
 */
const AGENT_MONITOR_CASE_CALL_ALLOWLIST = Object.freeze({
  assertAuditIntegrityMonitorArgs: 1,
  runAuditIntegrityMonitor: 1,
  formatAuditIntegrityMonitorReportJson: 1,
  'process.stdout.write': 1,
  auditIntegrityMonitorExitCode: 1,
  Error: 1,
});

function skipWsLeft(s, j) {
  while (j >= 0 && /\s/.test(s[j])) j -= 1;
  return j;
}

function readIdentLeft(s, end) {
  if (end < 0 || !isJsIdentPart(s[end])) return null;
  let j = end;
  while (j >= 0 && isJsIdentPart(s[j])) j -= 1;
  return { start: j + 1, end: end + 1, name: s.slice(j + 1, end + 1) };
}

function wordImmediatelyBefore(s, posExclusive) {
  const j = skipWsLeft(s, posExclusive - 1);
  if (j < 0 || !isJsIdentPart(s[j])) return null;
  return readIdentLeft(s, j);
}

/**
 * Lexical collect of real call callee paths on maskJsNonCode source.
 * Paths normalize whitespace around `.` (e.g. `process . stdout . write (` →
 * `process.stdout.write`). `new Error(` → `Error`.
 * Fail-closed opaque for `obj['send'](`, `fn?.(`, `(0, apiRequest)(`.
 * Declarations `function name(` and control `if (` are not calls.
 * Comment / string / template-text / regex decoys are ignored via the mask.
 *
 * @param {string} source
 * @returns {string[]}
 */
function collectRealCallCalleePaths(source) {
  const masked = maskJsNonCode(source);
  const paths = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '(') continue;
    const end = skipWsLeft(masked, i - 1);
    if (end < 0) continue;

    // Optional call: fn?.(
    if (masked[end] === '.' && end >= 1 && masked[end - 1] === '?') {
      paths.push(NON_STATIC_CALL_CALLEE);
      continue;
    }
    // Indirect / computed call: (0, apiRequest)(  or  obj['send'](
    if (masked[end] === ')' || masked[end] === ']') {
      paths.push(NON_STATIC_CALL_CALLEE);
      continue;
    }
    if (!isJsIdentPart(masked[end])) {
      if (masked[end] === '?') paths.push(NON_STATIC_CALL_CALLEE);
      continue;
    }

    const segs = [];
    let cursor = end;
    let opaque = false;
    let pathStart = end;
    while (true) {
      const id = readIdentLeft(masked, cursor);
      if (!id) {
        opaque = true;
        break;
      }
      segs.unshift(id.name);
      pathStart = id.start;
      const k = skipWsLeft(masked, id.start - 1);
      if (k < 0) break;
      // Optional chain: obj?.method(
      if (masked[k] === '.' && k >= 1 && masked[k - 1] === '?') {
        opaque = true;
        break;
      }
      if (masked[k] === '.') {
        const beforeDot = skipWsLeft(masked, k - 1);
        if (
          beforeDot < 0
          || masked[beforeDot] === ']'
          || !isJsIdentPart(masked[beforeDot])
        ) {
          opaque = true;
          break;
        }
        cursor = beforeDot;
        continue;
      }
      if (masked[k] === ']') {
        opaque = true;
        break;
      }
      break;
    }

    if (opaque) {
      paths.push(NON_STATIC_CALL_CALLEE);
      continue;
    }

    // function/class name(…) declaration — not a call
    const w = wordImmediatelyBefore(masked, pathStart);
    if (w && (w.name === 'function' || w.name === 'class')) {
      continue;
    }

    const path = segs.join('.');
    if (segs.length === 1 && PAREN_CONTROL_KEYWORDS.has(path)) {
      continue;
    }
    paths.push(path);
  }
  return paths;
}

/**
 * @param {string} source
 * @returns {{ paths: string[], tally: Record<string, number> }}
 */
function tallyRealCallCalleePaths(source) {
  const paths = collectRealCallCalleePaths(source);
  const tally = Object.create(null);
  for (const p of paths) {
    tally[p] = (tally[p] || 0) + 1;
  }
  return { paths, tally };
}

/**
 * Exact multiset equality vs allowlist map `{ path: count }`.
 * Shared by hostile canaries and the real agent case-body check (single SoT).
 *
 * @param {string} source
 * @param {Readonly<Record<string, number>>} allowlist
 */
function matchesExactCallPathAllowlist(source, allowlist) {
  const { tally } = tallyRealCallCalleePaths(source);
  const keys = new Set([...Object.keys(tally), ...Object.keys(allowlist)]);
  for (const k of keys) {
    if ((tally[k] || 0) !== (allowlist[k] || 0)) return false;
  }
  return true;
}

/**
 * Pre-fix weak denylist from historical test #12.
 * Kept only to prove false-green on apiRequest / http.get / unknown wrappers.
 * Not a second source of truth for GREEN.
 *
 * @param {string} body
 */
function agentMonitorCaseBodyPassesLegacyWeakDenylist(body) {
  const masked = maskJsNonCode(body);
  for (const bad of [
    'request',
    'fetch',
    'http',
    'https',
    'writeFile',
    'appendFile',
    'mkdir',
    'recoverAuditIntegrityDualWrite',
    'bootstrap',
    'publishDualWriteStateUnlocked',
    'setTimeout',
    'setInterval',
    'setImmediate',
  ]) {
    if (bad === 'http' || bad === 'https') {
      if (new RegExp(`\\b${bad}\\b`).test(masked) && hasCallSite(body, bad)) {
        return false;
      }
      if (
        collectStaticImportSpecifiers(body).some(
          (s) => s.includes(`node:${bad}`) || s === bad,
        )
      ) {
        return false;
      }
    } else if (hasCallSite(body, bad)) {
      return false;
    }
  }
  return true;
}

/**
 * Minimal case-body skeleton with exactly the allowlisted call multiset.
 * Used by hostile canaries (shared allowlist predicate, not a hand copy).
 */
function agentMonitorCaseBodyAllowlistSkeleton() {
  return `
    assertAuditIntegrityMonitorArgs(args, rawArgv);
    try {
      const report = await runAuditIntegrityMonitor(args['data-dir']);
      process.stdout.write(formatAuditIntegrityMonitorReportJson(report));
      process.exitCode = auditIntegrityMonitorExitCode(report);
    } catch {
      throw new Error(AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR);
    }
  `;
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
 * Parse a static '…' / "…" string at text[start] (must point at quote).
 * Returns { label, end } where end is index after closing quote, or null.
 */
function readStaticStringLiteral(text, start) {
  const q = text[start];
  if (q !== "'" && q !== '"') return null;
  let i = start + 1;
  let label = '';
  while (i < text.length) {
    if (text[i] === '\\') {
      if (i + 1 >= text.length) return null;
      label += text[i + 1];
      i += 2;
      continue;
    }
    if (text[i] === q) {
      return { label, end: i + 1 };
    }
    if (text[i] === '\n' || text[i] === '\r') return null;
    label += text[i];
    i += 1;
  }
  return null;
}

/**
 * Real switch `case 'label':` sites via hybrid mask+original scan.
 * `case` keyword only counts in code (maskJsNonCode); label read from original
 * static ' / " string; must be followed by colon. Regex/comment/string/template
 * text decoys never produce sites.
 * @returns {{ index: number, label: string, afterColon: number }[]}
 */
function findRealSwitchCaseSites(source) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const sites = [];
  let i = 0;
  while (i < masked.length) {
    if (
      masked.startsWith('case', i)
      && !isJsIdentPart(masked[i - 1])
      && !isJsIdentPart(masked[i + 4])
    ) {
      let j = i + 4;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const str = readStaticStringLiteral(text, j);
      if (str) {
        let k = str.end;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        if (text[k] === ':') {
          sites.push({ index: i, label: str.label, afterColon: k + 1 });
          i = k + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return sites;
}

function countCaseOccurrences(source, commandName) {
  return findRealSwitchCaseSites(source).filter((s) => s.label === commandName).length;
}

/**
 * Extract switch-case body after real `case 'label':` using masked brace balance.
 */
function extractSwitchCaseBody(source, caseLabel) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const site = findRealSwitchCaseSites(source).find((s) => s.label === caseLabel);
  if (!site) return null;
  let i = site.afterColon;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  if (masked[i] === '{') {
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
  const start = i;
  let depth = 0;
  for (let j = start; j < masked.length; j += 1) {
    if (masked[j] === '{') depth += 1;
    else if (masked[j] === '}') {
      if (depth === 0) return text.slice(start, j);
      depth -= 1;
    } else if (depth === 0) {
      if (/^\bbreak\b/.test(masked.slice(j))) {
        return text.slice(start, j);
      }
      if (/^\bcase\b/.test(masked.slice(j)) || /^\bdefault\b/.test(masked.slice(j))) {
        return text.slice(start, j);
      }
    }
  }
  return text.slice(start);
}

/**
 * Parse top-level properties of an object literal using masked structure.
 * @returns {Record<string, string>} prop → original value slice (trimmed)
 */
function parseObjectLiteralTopLevelProps(text, masked, openBrace, closeBrace) {
  const props = Object.create(null);
  let i = openBrace + 1;
  while (i < closeBrace) {
    // Commas / real whitespace only — do NOT skip masked string interiors (spaces).
    while (i < closeBrace && (masked[i] === ',' || /\s/.test(text[i]))) i += 1;
    if (i >= closeBrace) break;
    if (!/[A-Za-z_$]/.test(masked[i])) {
      i += 1;
      continue;
    }
    const keyStart = i;
    while (i < closeBrace && /[A-Za-z0-9_$]/.test(masked[i])) i += 1;
    const key = text.slice(keyStart, i);
    while (i < closeBrace && /\s/.test(text[i])) i += 1;
    // ES shorthand property: `{ checkedAt, ... }` — value is the identifier itself.
    if (text[i] !== ':') {
      if (text[i] === ',' || text[i] === '}' || i >= closeBrace) {
        props[key] = key;
      }
      continue;
    }
    i += 1;
    // Skip only real source whitespace so string literals (masked to spaces) stay values.
    while (i < closeBrace && /\s/.test(text[i])) i += 1;
    const valueStart = i;
    let depth = 0;
    while (i < closeBrace) {
      const c = masked[i];
      // Terminate on real top-level comma / close; masked string commas are spaces.
      if (depth === 0 && (c === ',' || (c === '}' && text[i] === '}'))) break;
      if (c === '{' || c === '[' || c === '(') depth += 1;
      else if (c === '}' || c === ']' || c === ')') depth -= 1;
      i += 1;
    }
    props[key] = text.slice(valueStart, i).trim();
  }
  return props;
}

/**
 * Locate ALL real `return calleeName(` sites on masked code.
 * count includes every site regardless of first-arg shape (object, call, identifier, …).
 * props is set only when count === 1 AND that sole call's first arg is an object literal.
 * Comments/strings/templates/regex cannot forge sites.
 * @returns {{ count: number, props: Record<string, string>|null }}
 */
function extractReturnedCallObjectLiteralProps(source, calleeName) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const re = new RegExp(
    `\\breturn\\s+${escapeRegExp(calleeName)}\\s*\\(`,
    'g',
  );
  /** @type {{ isObjectLiteral: boolean, props: Record<string, string>|null }[]} */
  const sites = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Point at '(' of the call (last char of match is '(')
    let i = m.index + m[0].length - 1;
    i += 1;
    while (i < masked.length && /\s/.test(text[i])) i += 1;
    if (masked[i] !== '{') {
      sites.push({ isObjectLiteral: false, props: null });
      continue;
    }
    const openBrace = i;
    let depth = 0;
    let props = null;
    for (let j = openBrace; j < masked.length; j += 1) {
      if (masked[j] === '{') depth += 1;
      else if (masked[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          props = parseObjectLiteralTopLevelProps(text, masked, openBrace, j);
          break;
        }
      }
    }
    sites.push({ isObjectLiteral: props != null, props });
  }
  if (sites.length === 1 && sites[0].isObjectLiteral) {
    return { count: 1, props: sites[0].props };
  }
  return { count: sites.length, props: null };
}

/**
 * True when masked body (trimmed) is solely:
 *   return <calleeName>({ ... });
 * with optional trailing semicolon and whitespace/comments already masked away.
 * Rejects leading if/extra statements/extra returns.
 */
function isSoleReturnCalleeObjectLiteralBody(source, calleeName) {
  const masked = maskJsNonCode(String(source)).trim();
  const head = new RegExp(`^return\\s+${escapeRegExp(calleeName)}\\s*\\(`);
  const m = head.exec(masked);
  if (!m) return false;
  let i = m[0].length - 1; // at '('
  i += 1;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  if (masked[i] !== '{') return false;
  let depth = 0;
  let j = i;
  for (; j < masked.length; j += 1) {
    if (masked[j] === '{') depth += 1;
    else if (masked[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        j += 1;
        break;
      }
    }
  }
  if (depth !== 0) return false;
  while (j < masked.length && /\s/.test(masked[j])) j += 1;
  if (masked[j] !== ')') return false;
  j += 1;
  while (j < masked.length && /\s/.test(masked[j])) j += 1;
  if (j < masked.length && masked[j] === ';') j += 1;
  while (j < masked.length && /\s/.test(masked[j])) j += 1;
  return j === masked.length;
}

/**
 * Legacy first-call extractor (intentionally weaker) — kept only to document
 * the dead-call false-green class; production scans must use the returned-call helper.
 * @returns {Record<string, string>|null}
 */
function extractFirstCallObjectLiteralProps(source, calleeName) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const re = new RegExp(`\\b${escapeRegExp(calleeName)}\\s*\\(`);
  const m = re.exec(masked);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  i += 1;
  while (i < masked.length && /\s/.test(text[i])) i += 1;
  if (masked[i] !== '{') return null;
  const openBrace = i;
  let depth = 0;
  for (let j = openBrace; j < masked.length; j += 1) {
    if (masked[j] === '{') depth += 1;
    else if (masked[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        return parseObjectLiteralTopLevelProps(text, masked, openBrace, j);
      }
    }
  }
  return null;
}

/**
 * Extract exact initializer of `const name = …` from original source via masked locate.
 * For string literals returns including quotes; otherwise trimmed slice to `;`.
 * @returns {string|null}
 */
function extractConstInitializer(source, name) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const re = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=`);
  const m = re.exec(masked);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] === "'" || text[i] === '"') {
    const str = readStaticStringLiteral(text, i);
    return str ? text.slice(i, str.end) : null;
  }
  const start = i;
  let depth = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (depth === 0 && (c === ';' || c === '\n' || c === '\r')) break;
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    i += 1;
  }
  return text.slice(start, i).trim();
}

/** True when value slice is exact string literal equal to expected (single or double quotes). */
function isExactStringLiteralValue(valueSlice, expected) {
  const v = String(valueSlice).trim();
  return v === `'${expected}'` || v === `"${expected}"`;
}

/** True when value slice is exact null keyword. */
function isExactNullLiteral(valueSlice) {
  return String(valueSlice).trim() === 'null';
}

/** Forbidden compound assembled at runtime (never write full adjacent literal). */
function forbiddenTamperEvidentNeedle() {
  return ['tamper', 'evident'].join('-');
}

async function readText(absPath) {
  return readFile(absPath, 'utf8');
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-aim-c4-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}
function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}
function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}
function eventLine(event) {
  return `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout:${label}:${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stripCheckedAt(report) {
  const copy = { ...report };
  delete copy.checkedAt;
  return copy;
}

/**
 * Zero-write snapshot: root + audit triple files.
 * existence / type (file|dir|symlink|other); regular file size + sha256(bytes).
 * Does not follow symlinks; never reads env/secret.
 */
async function snapshotPathEntry(absPath) {
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) {
      return { exists: true, type: 'symlink', size: null, sha256: null };
    }
    if (st.isDirectory()) {
      return { exists: true, type: 'dir', size: null, sha256: null };
    }
    if (st.isFile()) {
      const bytes = await readFile(absPath);
      return {
        exists: true,
        type: 'file',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    return { exists: true, type: 'other', size: null, sha256: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { exists: false, type: null, size: null, sha256: null };
    }
    throw e;
  }
}

/**
 * Non-recursive sorted directory entries (symlink not followed).
 * Missing path → { exists:false, type:null, entries:null }.
 */
async function listSortedDirEntries(absPath) {
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) {
      return { exists: true, type: 'symlink', entries: null };
    }
    if (!st.isDirectory()) {
      return {
        exists: true,
        type: st.isFile() ? 'file' : 'other',
        entries: null,
      };
    }
    const names = await readdir(absPath);
    return { exists: true, type: 'dir', entries: [...names].sort() };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { exists: false, type: null, entries: null };
    }
    throw e;
  }
}

/**
 * Zero-write snapshot: root + audit dir listings + audit triple files.
 * rootEntries / auditEntries catch new sibling files (spool/tmp/bypass).
 */
async function snapshotRootAndAuditTriple(root) {
  return {
    root: await snapshotPathEntry(root),
    rootEntries: await listSortedDirEntries(root),
    auditEntries: await listSortedDirEntries(join(root, 'audit')),
    state: await snapshotPathEntry(stateAbs(root)),
    journal: await snapshotPathEntry(journalAbs(root)),
    events: await snapshotPathEntry(eventsAbs(root)),
  };
}

function assertSnapshotEqual(before, after, label) {
  assert.deepEqual(after, before, `${label}: zero-write snapshot mismatch`);
}

async function loadMonitor() {
  return import('../src/audit-integrity-monitor.js');
}
async function loadCoordinator() {
  return import('../src/audit-integrity-dual-write.js');
}
async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}
async function loadState() {
  return import('../src/audit-integrity-dual-write-state.js');
}

async function ensureHealthyIdle(root) {
  const { appendAuditEventWithIntegrityDualWrite } = await loadCoordinator();
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
}

async function runMonitor(root) {
  const { runAuditIntegrityMonitor } = await loadMonitor();
  return runAuditIntegrityMonitor(root);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. scan helper hostile canaries
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 A: scan helper hostile canaries (anti false-green)', () => {
  it('1. JS lexical mask: comment/string/template-text/regex fake calls ignored; template ${expr} real call counts', () => {
    const name = 'writeFile';
    assert.equal(hasCallSite(`// ${name}()\nconst x = 1;`, name), false);
    assert.equal(hasCallSite(`/* ${name}() */`, name), false);
    assert.equal(hasCallSite(`const s = "${name}()";`, name), false);
    assert.equal(hasCallSite('const s = `' + name + '()`;', name), false);
    assert.equal(hasCallSite('const r = /' + name + '\\(/;', name), false);

    // Real call after comment noise
    assert.equal(hasCallSite(`// ${name}()\n${name}(p);`, name), true);
    assert.equal(countCallSites(`// ${name}()\n${name}(p);`, name), 1);

    // Template expression keeps real call
    const tplExpr = 'const t = `x${' + name + '(p)}y`;';
    assert.equal(hasCallSite(tplExpr, name), true);
    assert.equal(countCallSites(tplExpr, name), 1);
  });

  it('1b. call-path collector: member/new; fail-closed computed/optional/indirect; legacy denylist false-green; decoys clean', () => {
    // Static path collection (whitespace-normalized member chains; new → ctor name)
    assert.deepEqual(collectRealCallCalleePaths('foo(1);'), ['foo']);
    assert.deepEqual(collectRealCallCalleePaths('obj.method(1);'), ['obj.method']);
    assert.deepEqual(
      collectRealCallCalleePaths('process\n  . stdout\n  .write (x);'),
      ['process.stdout.write'],
    );
    assert.deepEqual(collectRealCallCalleePaths('throw new Error(x);'), ['Error']);
    assert.deepEqual(collectRealCallCalleePaths('new\n  Error(x);'), ['Error']);
    assert.deepEqual(collectRealCallCalleePaths('if (x) foo();'), ['foo']);
    assert.deepEqual(collectRealCallCalleePaths('function bar() { return 1; }'), []);

    // Fail-closed opaque — cannot slip past exact allowlist
    for (const code of [
      "obj['send'](1);",
      'fn?.();',
      'obj?.method();',
      '(0, apiRequest)();',
      '(apiRequest)();',
    ]) {
      const paths = collectRealCallCalleePaths(code);
      assert.equal(paths.length, 1, code);
      assert.equal(paths[0], NON_STATIC_CALL_CALLEE, code);
      assert.equal(
        matchesExactCallPathAllowlist(code, AGENT_MONITOR_CASE_CALL_ALLOWLIST),
        false,
        `opaque must fail allowlist: ${code}`,
      );
    }

    // Skeleton is exact GREEN via the shared allowlist predicate
    const skeleton = agentMonitorCaseBodyAllowlistSkeleton();
    assert.equal(
      matchesExactCallPathAllowlist(skeleton, AGENT_MONITOR_CASE_CALL_ALLOWLIST),
      true,
      'skeleton must be exact allowlist GREEN',
    );
    const skTally = tallyRealCallCalleePaths(skeleton).tally;
    assert.deepEqual(
      Object.fromEntries(Object.keys(AGENT_MONITOR_CASE_CALL_ALLOWLIST).sort().map(
        (k) => [k, skTally[k]],
      )),
      { ...AGENT_MONITOR_CASE_CALL_ALLOWLIST },
    );
    assert.equal(Object.keys(skTally).length, Object.keys(AGENT_MONITOR_CASE_CALL_ALLOWLIST).length);

    // Hostile real calls: legacy weak denylist false-greens; exact allowlist RED
    const hostiles = [
      {
        label: 'apiRequest',
        inject: "await apiRequest('/api/x', 'POST', {});",
        expectPath: 'apiRequest',
      },
      {
        label: 'http.get',
        inject: "http.get('http://evil');",
        expectPath: 'http.get',
      },
      {
        label: 'evilWrapper',
        inject: 'evilWrapper();',
        expectPath: 'evilWrapper',
      },
      {
        label: 'client.send',
        inject: 'client.send();',
        expectPath: 'client.send',
      },
    ];
    for (const h of hostiles) {
      const body = `${h.inject}\n${skeleton}`;
      assert.equal(
        agentMonitorCaseBodyPassesLegacyWeakDenylist(body),
        true,
        `legacy weak denylist false-green on ${h.label}`,
      );
      assert.equal(
        matchesExactCallPathAllowlist(body, AGENT_MONITOR_CASE_CALL_ALLOWLIST),
        false,
        `exact allowlist must RED on ${h.label}`,
      );
      const { tally } = tallyRealCallCalleePaths(body);
      assert.equal(tally[h.expectPath], 1, `collector must see ${h.expectPath}`);
    }

    // comment / string / template / regex decoys must not false-red
    const decoy = `
// await apiRequest('/api/x', 'POST', {})
/* http.get('http://evil') */
const s = "evilWrapper()";
const t = \`client.send()\`;
const r = /apiRequest\\(/;
const u = /http\\.get\\(/;
${skeleton}
`;
    assert.equal(
      matchesExactCallPathAllowlist(decoy, AGENT_MONITOR_CASE_CALL_ALLOWLIST),
      true,
      'comment/string/template/regex decoys must not false-red',
    );
    assert.equal(agentMonitorCaseBodyPassesLegacyWeakDenylist(decoy), true);
  });

  it('2. static import extractor: multiline; comment/string/regex decoy not blind', () => {
    const hostile = "const r=/a\\/\\/b/;\nimport { x } from './real.js';";
    assert.deepEqual(collectStaticImportSpecifiers(hostile), ['./real.js']);

    const multi = "import {\n  a,\n  b,\n} from './mod.js';\nimport './side.js';";
    assert.deepEqual(collectStaticImportSpecifiers(multi), ['./mod.js', './side.js']);

    assert.deepEqual(collectStaticImportSpecifiers("const x = import('node:fs');"), []);

    const noise =
      "const s = \"import './fake.js'\";\n// import './c.js'\n/*\nimport './b.js'\n*/\nimport './real.js';";
    assert.deepEqual(collectStaticImportSpecifiers(noise), ['./real.js']);

    const templateImport = 'const t = `\nimport \'./tpl.js\'\n`;\nimport \'./real-tpl.js\';';
    assert.deepEqual(collectStaticImportSpecifiers(templateImport), ['./real-tpl.js']);
  });

  it('3. function-body extractor resists default-param {} / comment/string braces', () => {
    const defaultParam = `
export async function sampleDefault(options = {}) {
  return options.x;
}
`;
    const defaultBody = extractFunctionBody(defaultParam, 'sampleDefault');
    assert.ok(defaultBody != null);
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
    assert.ok(braceBody != null);
    assert.ok(braceBody.includes('return s + t + u'));
  });

  it('4. honesty clause scanner: positive caught; Not/no/未/BLOCKED pass; prior Not cannot shield later positive; BLOCKED inventory ends correctly', () => {
    const positive = 'remote alert delivered and production monitoring ready';
    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'remote alert delivered').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(positive, 'production monitoring ready').length, 1);

    const blocked = '* BLOCKED: T6d.3 complete / M6d Exit / production-hardening ready';
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'M6d Exit').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(blocked, 'production-hardening ready').length, 0);

    const negative = 'Not T6d.3 complete; no remote alert delivered; 未 production monitoring ready';
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'remote alert delivered').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(negative, 'production monitoring ready').length, 0);

    // Prior Not must not cover later positive after clause split
    const earlyNot =
      'Not T6d.3 complete. production-hardening ready is shipped; M6d Exit done';
    assert.equal(findUnqualifiedHonestyPhraseLines(earlyNot, 'T6d.3 complete').length, 0);
    assert.equal(findUnqualifiedHonestyPhraseLines(earlyNot, 'production-hardening ready').length, 1);
    assert.equal(findUnqualifiedHonestyPhraseLines(earlyNot, 'M6d Exit').length, 1);

    // BLOCKED inventory: bullets under header are covered; later non-bullet is not
    // (avoid "without"/"no" in the positive line — those are negative context).
    const inventory = [
      'BLOCKED:',
      '- T6d.3 complete',
      '- multi-process exclusive lock',
      '',
      'T6d.3 complete is shipped now',
    ].join('\n');
    assert.equal(findUnqualifiedHonestyPhraseLines(inventory, 'T6d.3 complete').length, 1);
    assert.equal(
      findUnqualifiedHonestyPhraseLines(inventory, 'multi-process exclusive lock').length,
      0,
    );
  });

  it('4a. honesty: bare limitation/partial only/still partial must NOT shield positive claims', () => {
    assert.equal(
      findUnqualifiedHonestyPhraseLines('T6d.3 complete limitation noted', 'T6d.3 complete').length,
      1,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines('T6d.3 complete partial only', 'T6d.3 complete').length,
      1,
    );
    // Bare "still partial" is not a negative shield (was a false-green class).
    assert.equal(
      findUnqualifiedHonestyPhraseLines('T6d.3 complete still partial', 'T6d.3 complete').length,
      1,
      'bare still partial must not shield positive T6d.3 complete',
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines('T6d.3 complete still-partial', 'T6d.3 complete').length,
      1,
    );
    // True negative contexts still pass.
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Limitation: not T6d.3 complete',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'T6d.3 still partial only; not T6d.3 complete',
        'T6d.3 complete',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Not T6d.3 complete; still partial only',
        'T6d.3 complete',
      ).length,
      0,
    );
  });

  it('4b. honesty: bare "as delivered" must NOT shield positive claim; FORBIDDEN inventory ends at new heading', () => {
    // True RED against the former escape rule that treated any "as delivered" as negative.
    const escape = 'remote alert delivered as delivered';
    assert.equal(
      findUnqualifiedHonestyPhraseLines(escape, 'remote alert delivered').length,
      1,
      'positive claim with trailing "as delivered" must still be an offender',
    );

    // Cross-heading: FORBIDDEN inventory must not shelter later ## Delivered bullets.
    const crossHeading = [
      'FORBIDDEN as delivered claims:',
      '- remote alert delivered',
      '- production monitoring ready',
      '',
      '## Delivered',
      '',
      '- remote alert delivered',
    ].join('\n');
    const offenders = findUnqualifiedHonestyPhraseLines(crossHeading, 'remote alert delivered');
    assert.equal(
      offenders.length,
      1,
      'exactly one offender under ## Delivered (FORBIDDEN bullet covered)',
    );
    assert.ok(
      offenders[0].text.includes('remote alert delivered'),
      'offender must be the post-heading positive bullet',
    );
    assert.ok(
      offenders[0].line > 4,
      'offender line must be after the ## Delivered heading',
    );

    // Same-clause real negation still allowed.
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        'Not remote alert delivered; no production monitoring ready',
        'remote alert delivered',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(
        '* BLOCKED: remote alert delivered / production monitoring ready',
        'remote alert delivered',
      ).length,
      0,
    );
  });

  it('5. hostile canary: comment/string-only forbidden write call/import/case cannot false-fail or false-green', () => {
    // False-green protection: decoy-only source has zero real call/import/case
    const decoyOnly = `
// writeFile(path)
/* import './audit-integrity-monitor.js' */
const s = "case 'audit-integrity-monitor':";
const t = 'recoverAuditIntegrityDualWrite()';
// case 'audit-integrity-monitor':
const r = /case 'audit-integrity-monitor':/;
const tpl = \`case 'audit-integrity-monitor':\`;
`;
    assert.equal(hasCallSite(decoyOnly, 'writeFile'), false);
    assert.equal(hasCallSite(decoyOnly, 'recoverAuditIntegrityDualWrite'), false);
    assert.deepEqual(collectStaticImportSpecifiers(decoyOnly), []);
    assert.equal(countCaseOccurrences(decoyOnly, 'audit-integrity-monitor'), 0);
    assert.equal(extractSwitchCaseBody(decoyOnly, 'audit-integrity-monitor'), null);

    // Real code is still detected
    const real = `
// writeFile(path)
import { runAuditIntegrityMonitor } from './audit-integrity-monitor.js';
switch (cmd) {
  // case 'audit-integrity-monitor':
  case 'audit-integrity-monitor': {
    writeFile(p);
    break;
  }
}
`;
    assert.equal(hasCallSite(real, 'writeFile'), true);
    assert.deepEqual(collectStaticImportSpecifiers(real), ['./audit-integrity-monitor.js']);
    assert.equal(countCaseOccurrences(real, 'audit-integrity-monitor'), 1);
    assert.ok(extractSwitchCaseBody(real, 'audit-integrity-monitor') != null);

    // Mix: regex/string/template/comment decoys + one real case → exact 1
    const mixed = `
const r = /case 'audit-integrity-monitor':/;
const s = "case 'audit-integrity-monitor':";
const t = \`case 'audit-integrity-monitor':\`;
// case 'audit-integrity-monitor':
switch (x) {
  case 'audit-integrity-monitor': { ok(); break; }
}
`;
    assert.equal(countCaseOccurrences(mixed, 'audit-integrity-monitor'), 1);
    const mixedBody = extractSwitchCaseBody(mixed, 'audit-integrity-monitor');
    assert.ok(mixedBody != null && mixedBody.includes('ok()'));
  });

  it('5b. returned freezeReport props: dead non-return call cannot shelter wrong return; decoys fail', () => {
    const real = `
function failClosedMalformedReport(checkedAt) {
  return freezeReport({
    status: 'alert',
    code: 'integrity-alert',
    dualWriteState: 'unknown',
    relationship: null,
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: null,
  });
}
`;
    const realHit = extractReturnedCallObjectLiteralProps(real, 'freezeReport');
    assert.equal(realHit.count, 1);
    assert.ok(realHit.props != null);
    assert.ok(isExactStringLiteralValue(realHit.props.code, 'integrity-alert'));
    assert.ok(isExactStringLiteralValue(realHit.props.dualWriteState, 'unknown'));
    assert.ok(isExactNullLiteral(realHit.props.reasonCode));
    assert.ok(isExactStringLiteralValue(realHit.props.status, 'alert'));
    assert.ok(isExactNullLiteral(realHit.props.relationship));
    assert.equal(realHit.props.recoveryRequired, 'false');
    assert.ok(isExactStringLiteralValue(realHit.props.nextAction, 'investigate-integrity'));
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(real, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      true,
    );

    // Dead correct call + wrong object return: first-call helper false-greens.
    const deadThenWrong = `
function failClosedMalformedReport(checkedAt) {
  if (false) freezeReport({
    status: 'alert', code: 'integrity-alert', checkedAt,
    dualWriteState: 'unknown', relationship: null,
    recoveryRequired: false, nextAction: 'investigate-integrity', reasonCode: null,
  });
  return freezeReport({
    status: 'healthy', code: 'healthy', checkedAt,
    dualWriteState: 'idle', relationship: 'exact-match',
    recoveryRequired: false, nextAction: 'none', reasonCode: null,
  });
}
`;
    const firstCallProps = extractFirstCallObjectLiteralProps(deadThenWrong, 'freezeReport');
    assert.ok(firstCallProps != null, 'legacy first-call helper finds a site');
    assert.ok(
      isExactStringLiteralValue(firstCallProps.code, 'integrity-alert'),
      'RED evidence: first-call helper false-greens on dead correct freezeReport',
    );
    const returned = extractReturnedCallObjectLiteralProps(deadThenWrong, 'freezeReport');
    assert.equal(returned.count, 1);
    assert.ok(returned.props != null);
    assert.ok(
      isExactStringLiteralValue(returned.props.code, 'healthy'),
      'returned helper must read the actual return freezeReport object',
    );
    assert.equal(isExactStringLiteralValue(returned.props.code, 'integrity-alert'), false);
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(deadThenWrong, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      false,
      'extra if(false) statement must fail sole-return structure',
    );

    // Dead correct object return + live non-object return: old object-only count false-greens as 1.
    const deadObjectReturnLiveCall = `
function failClosedMalformedReport(checkedAt) {
  if (false) return freezeReport({
    status: 'alert', code: 'integrity-alert', checkedAt,
    dualWriteState: 'unknown', relationship: null,
    recoveryRequired: false, nextAction: 'investigate-integrity', reasonCode: null,
  });
  return freezeReport(buildWrongHealthyReport());
}
`;
    // Simulate pre-fix object-only counting by only extracting object returns:
    const objectOnlyCount = (() => {
      const text = deadObjectReturnLiveCall;
      const masked = maskJsNonCode(text);
      const re = /\breturn\s+freezeReport\s*\(/g;
      let n = 0;
      let mm;
      while ((mm = re.exec(masked)) !== null) {
        let i = mm.index + mm[0].length;
        while (i < masked.length && /\s/.test(text[i])) i += 1;
        if (masked[i] === '{') n += 1;
      }
      return n;
    })();
    assert.equal(
      objectOnlyCount,
      1,
      'RED evidence: object-literal-only count ignores live non-object return freezeReport',
    );
    const liveCallHit = extractReturnedCallObjectLiteralProps(
      deadObjectReturnLiveCall,
      'freezeReport',
    );
    assert.equal(liveCallHit.count, 2, 'must count all return freezeReport( sites');
    assert.equal(liveCallHit.props, null, 'multi-return must fail closed on props');
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(deadObjectReturnLiveCall, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      false,
    );

    // Dead correct return + live plain object return → count 2, props null
    const twoObjectReturns = `
function failClosedMalformedReport(checkedAt) {
  if (false) return freezeReport({
    status: 'alert', code: 'integrity-alert', checkedAt,
    dualWriteState: 'unknown', relationship: null,
    recoveryRequired: false, nextAction: 'investigate-integrity', reasonCode: null,
  });
  return freezeReport({
    status: 'healthy', code: 'healthy', checkedAt,
    dualWriteState: 'idle', relationship: 'exact-match',
    recoveryRequired: false, nextAction: 'none', reasonCode: null,
  });
}
`;
    const twoHit = extractReturnedCallObjectLiteralProps(twoObjectReturns, 'freezeReport');
    assert.equal(twoHit.count, 2);
    assert.equal(twoHit.props, null);
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(twoObjectReturns, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      false,
    );

    // Zero return freezeReport sites → fail closed
    const noReturn = `
function failClosedMalformedReport(checkedAt) {
  freezeReport({ code: 'integrity-alert', dualWriteState: 'unknown', reasonCode: null });
  return checkedAt;
}
`;
    assert.equal(extractReturnedCallObjectLiteralProps(noReturn, 'freezeReport').count, 0);
    assert.equal(extractReturnedCallObjectLiteralProps(noReturn, 'freezeReport').props, null);
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(noReturn, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      false,
    );

    // Multiple return freezeReport sites → fail closed (count !== 1)
    const multiReturn = `
function failClosedMalformedReport(checkedAt) {
  if (checkedAt) return freezeReport({ code: 'integrity-alert', dualWriteState: 'unknown', reasonCode: null });
  return freezeReport({ code: 'healthy', dualWriteState: 'idle', reasonCode: null });
}
`;
    assert.equal(extractReturnedCallObjectLiteralProps(multiReturn, 'freezeReport').count, 2);
    assert.equal(extractReturnedCallObjectLiteralProps(multiReturn, 'freezeReport').props, null);

    // Sole non-object return freezeReport → count 1, props null
    const soleNonObject = `
function failClosedMalformedReport(checkedAt) {
  return freezeReport(buildWrongHealthyReport());
}
`;
    const soleNon = extractReturnedCallObjectLiteralProps(soleNonObject, 'freezeReport');
    assert.equal(soleNon.count, 1);
    assert.equal(soleNon.props, null);
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(soleNonObject, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      false,
    );

    // Extra statement before sole return → structure fails
    const extraStmt = `
function failClosedMalformedReport(checkedAt) {
  const x = 1;
  return freezeReport({
    status: 'alert', code: 'integrity-alert', dualWriteState: 'unknown',
    relationship: null, recoveryRequired: false, nextAction: 'investigate-integrity', reasonCode: null,
  });
}
`;
    const extraHit = extractReturnedCallObjectLiteralProps(extraStmt, 'freezeReport');
    assert.equal(extraHit.count, 1);
    assert.ok(extraHit.props != null);
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(
        extractFunctionBody(extraStmt, 'failClosedMalformedReport'),
        'freezeReport',
      ),
      false,
      'leading statement must fail sole-return structure',
    );

    // Comment-only decoy
    const commentOnly = `
function failClosedMalformedReport(checkedAt) {
  // return freezeReport({ code: 'integrity-alert', dualWriteState: 'unknown', reasonCode: null })
  return checkedAt;
}
`;
    assert.equal(extractReturnedCallObjectLiteralProps(commentOnly, 'freezeReport').count, 0);
    const decoyBody = extractFunctionBody(commentOnly, 'failClosedMalformedReport');
    assert.ok(/reasonCode\s*:\s*null/.test(decoyBody));

    // String / template / regex forgeries + non-object return
    const forged = `
const s = "return freezeReport({ code: 'integrity-alert', dualWriteState: 'unknown', reasonCode: null })";
const t = \`return freezeReport({ code: 'integrity-alert' })\`;
const r = /return freezeReport\\(\\{ code: 'integrity-alert' \\}\\)/;
return freezeReport(checkedAt);
`;
    const forgedHit = extractReturnedCallObjectLiteralProps(forged, 'freezeReport');
    assert.equal(forgedHit.count, 1, 'real non-object return counts; decoys do not');
    assert.equal(forgedHit.props, null);
  });

  it('5c. const initializer helper: comment/string/template/regex decoy cannot forge exact literal', () => {
    const real = "const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'audit-integrity-monitor failed';\n";
    assert.equal(
      extractConstInitializer(real, 'AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR'),
      "'audit-integrity-monitor failed'",
    );
    const decoy = `
// const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'audit-integrity-monitor failed';
const s = "const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'audit-integrity-monitor failed'";
const t = \`const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'audit-integrity-monitor failed'\`;
const r = /AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'audit-integrity-monitor failed'/;
const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR = 'wrong';
`;
    // Old raw src regex false-greens on comment/string:
    assert.equal(
      /AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR\s*=\s*['"]audit-integrity-monitor failed['"]/.test(
        decoy,
      ),
      true,
      'old raw regex false-green evidence',
    );
    const init = extractConstInitializer(decoy, 'AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR');
    assert.equal(init, "'wrong'");
    assert.equal(isExactStringLiteralValue(init, 'audit-integrity-monitor failed'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Static / source freezes
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 B: static/source freezes', () => {
  it('6. monitor real call-sites have no write/recover/bootstrap/publish/fs mutators', async () => {
    const src = await readText(PATHS.monitor);
    for (const name of WRITE_CALLEES) {
      assert.equal(hasCallSite(src, name), false, `forbidden call-site ${name}`);
    }
    // Prefix wildcards via masked scan for safeAtomicWrite* / safeAppend* style
    const masked = maskJsNonCode(src);
    assert.equal(/\bsafeAtomicWrite\w*\s*\(/.test(masked), false);
    assert.equal(/\bsafeAppend\w*\s*\(/.test(masked), false);
    assert.equal(/\bpublishDualWrite\w*\s*\(/.test(masked), false);
    assert.equal(/\bbootstrap\w*\s*\(/.test(masked), false);
    assert.equal(/\brecoverAudit\w*\s*\(/.test(masked), false);
  });

  it('7. monitor static imports exact one dual-write specifier + binding inspectAuditIntegrityDualWriteReadOnly', async () => {
    const src = await readText(PATHS.monitor);
    const specs = collectStaticImportSpecifiers(src);
    assert.deepEqual(specs, ['./audit-integrity-dual-write.js']);
    const bindings = collectImportedBindingsFromSpecifier(src, './audit-integrity-dual-write.js');
    assert.deepEqual(bindings, ['inspectAuditIntegrityDualWriteReadOnly']);

    for (const needle of FORBIDDEN_MONITOR_IMPORT_NEEDLES) {
      assert.equal(
        specs.some((s) => s.includes(needle)),
        false,
        `forbidden specifier needle ${needle}`,
      );
    }
    for (const bad of [
      './audit-log.js',
      './server.js',
      './agent.js',
      './audit-integrity-write-queue.js',
      './audit-integrity-dual-write-state.js',
      './audit-integrity-journal.js',
      './audit-integrity-cross-store.js',
      './error-codes.js',
      './safe-data-files.js',
    ]) {
      assert.equal(specs.includes(bad), false, `forbidden import ${bad}`);
    }
  });

  it('8. monitor has no reasonCode membership whitelist / ERROR_CODES registry copy / assertRegisteredErrorCode', async () => {
    const src = await readText(PATHS.monitor);
    const masked = maskJsNonCode(src);
    assert.equal(/\bERROR_CODES\b/.test(masked), false);
    assert.equal(/\bassertRegisteredErrorCode\b/.test(masked), false);
    assert.equal(/Object\.values\s*\(\s*ERROR_CODES\s*\)/.test(masked), false);
    // Structural guard must exist as real identifier in code (not unmasked comment fallback).
    assert.ok(
      /\bisStructuralPathFreeKebabReason\b/.test(masked),
      'structural reason guard identifier must exist in masked code',
    );
    const guardBody = extractFunctionBody(src, 'isStructuralPathFreeKebabReason');
    assert.ok(guardBody != null, 'isStructuralPathFreeKebabReason body must extract');
    // Comment-only decoy must not pass masked identifier check.
    const commentDecoy = `
// function isStructuralPathFreeKebabReason(code) { return true; }
// structural path-free kebab
const x = 1;
`;
    assert.equal(/\bisStructuralPathFreeKebabReason\b/.test(maskJsNonCode(commentDecoy)), false);
    assert.equal(/Object\.keys\s*\(\s*ERROR_CODES\s*\)/.test(masked), false);
  });

  it('9. malformed observation fail-closed path: sole return freezeReport props integrity-alert/unknown/null', async () => {
    const src = await readText(PATHS.monitor);
    const failBody = extractFunctionBody(src, 'failClosedMalformedReport');
    assert.ok(failBody != null, 'failClosedMalformedReport body must extract');
    // Structure freeze: body is only `return freezeReport({...});` (no if/extra stmt/extra return).
    assert.equal(
      isSoleReturnCalleeObjectLiteralBody(failBody, 'freezeReport'),
      true,
      'failClosedMalformedReport body must be solely return freezeReport({...});',
    );
    const hit = extractReturnedCallObjectLiteralProps(failBody, 'freezeReport');
    assert.equal(
      hit.count,
      1,
      'failClosedMalformedReport must have exactly one return freezeReport(…)',
    );
    const props = hit.props;
    assert.ok(props != null, 'sole return freezeReport first arg must be object literal');
    assert.ok(
      isExactStringLiteralValue(props.code, 'integrity-alert'),
      `code=${props.code}`,
    );
    assert.ok(
      isExactStringLiteralValue(props.dualWriteState, 'unknown'),
      `dualWriteState=${props.dualWriteState}`,
    );
    assert.ok(isExactNullLiteral(props.reasonCode), `reasonCode=${props.reasonCode}`);
    assert.ok(isExactStringLiteralValue(props.status, 'alert'));
    assert.ok(isExactNullLiteral(props.relationship));
    assert.equal(String(props.recoveryRequired).trim(), 'false');
    assert.ok(isExactStringLiteralValue(props.nextAction, 'investigate-integrity'));
    // checkedAt must be the identifier checkedAt (not a forged string)
    assert.equal(String(props.checkedAt).trim(), 'checkedAt');

    // Comment-only body: returned helper fail-closed.
    const decoy = `
function failClosedMalformedReport(checkedAt) {
  // return freezeReport({ code: 'integrity-alert', dualWriteState: 'unknown', reasonCode: null })
  // code: 'integrity-alert'
  // dualWriteState: 'unknown'
  // reasonCode: null
  return checkedAt;
}
`;
    const decoyBody = extractFunctionBody(decoy, 'failClosedMalformedReport');
    assert.ok(decoyBody != null);
    const decoyHit = extractReturnedCallObjectLiteralProps(decoyBody, 'freezeReport');
    assert.equal(decoyHit.count, 0);
    assert.equal(decoyHit.props, null);
    assert.equal(isSoleReturnCalleeObjectLiteralBody(decoyBody, 'freezeReport'), false);
    assert.equal(/reasonCode\s*:\s*null/.test(decoyBody), true);
    assert.equal(/code\s*:\s*['"]integrity-alert['"]/.test(decoyBody), true);
  });

  it('10. agent imports monitor exact public 3 APIs run/format/exit; no C1 inspector/unlocked import', async () => {
    const src = await readText(PATHS.agent);
    const specs = collectStaticImportSpecifiers(src);
    assert.ok(specs.includes('./audit-integrity-monitor.js'));
    const bindings = collectImportedBindingsFromSpecifier(src, './audit-integrity-monitor.js');
    assert.deepEqual(
      [...bindings].sort(),
      [
        'auditIntegrityMonitorExitCode',
        'formatAuditIntegrityMonitorReportJson',
        'runAuditIntegrityMonitor',
      ].sort(),
    );
    assert.equal(bindings.length, 3);

    // No C1 inspector / unlocked dual-write mutators on agent
    assert.equal(specs.includes('./audit-integrity-dual-write.js'), false);
    assert.equal(hasCallSite(src, 'inspectAuditIntegrityDualWriteReadOnly'), false);
    assert.equal(hasCallSite(src, 'publishDualWriteStateUnlocked'), false);
    assert.equal(hasCallSite(src, 'loadDualWriteStateUnlocked'), false);
  });

  it('11. agent exact-one real switch case audit-integrity-monitor; comment/regex/string decoy ignored', async () => {
    const src = await readText(PATHS.agent);
    assert.equal(countCaseOccurrences(src, 'audit-integrity-monitor'), 1);

    // Hostile: comment / string / regex / template decoys, count is 0
    const decoy = `
// case 'audit-integrity-monitor':
/* case 'audit-integrity-monitor': */
const s = "case 'audit-integrity-monitor':";
const r = /case 'audit-integrity-monitor':/;
const t = \`case 'audit-integrity-monitor':\`;
`;
    assert.equal(countCaseOccurrences(decoy, 'audit-integrity-monitor'), 0);
    assert.equal(extractSwitchCaseBody(decoy, 'audit-integrity-monitor'), null);
  });

  it('12. agent case body exact call allowlist (validator/run/format/stdout.write/exit/Error×1 each); validator outside try; bare catch', async () => {
    const src = await readText(PATHS.agent);
    const body = extractSwitchCaseBody(src, 'audit-integrity-monitor');
    assert.ok(body != null && body.length > 0, 'case body must extract');
    const masked = maskJsNonCode(body);

    // Single SoT: exact call-path multiset (blocks apiRequest/http.get/unknown wrappers/
    // write/timer/recover/opaque computed-optional-indirect naturally).
    const { paths, tally } = tallyRealCallCalleePaths(body);
    assert.equal(
      matchesExactCallPathAllowlist(body, AGENT_MONITOR_CASE_CALL_ALLOWLIST),
      true,
      `case body call paths must exact-match allowlist; got ${JSON.stringify(tally)} paths=${JSON.stringify(paths)}`,
    );
    assert.equal(paths.length, 6, 'exact total call count');
    assert.equal(tally.assertAuditIntegrityMonitorArgs, 1);
    assert.equal(tally.runAuditIntegrityMonitor, 1);
    assert.equal(tally.formatAuditIntegrityMonitorReportJson, 1);
    assert.equal(tally['process.stdout.write'], 1);
    assert.equal(tally.auditIntegrityMonitorExitCode, 1);
    assert.equal(tally.Error, 1);
    assert.equal(Object.keys(tally).length, 6);

    // No static network imports inside the case body either
    assert.equal(
      collectStaticImportSpecifiers(body).some(
        (s) => s.includes('node:http') || s.includes('node:https') || s === 'http' || s === 'https',
      ),
      false,
    );

    // Validator outside execution try: assert... appears before try {
    const tryIdx = masked.search(/\btry\s*\{/);
    const valIdx = masked.search(/\bassertAuditIntegrityMonitorArgs\s*\(/);
    assert.ok(valIdx >= 0 && tryIdx >= 0, 'validator and try must both exist');
    assert.ok(valIdx < tryIdx, 'validator must be outside/before execution try');

    // Post-validation bare catch (no binding) with fixed desensitized throw constant
    assert.ok(/\bcatch\s*\{/.test(masked), 'bare catch required');
    assert.ok(
      /\bAUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR\b/.test(masked),
      'case body must throw fixed execution-error constant',
    );
    const execInit = extractConstInitializer(src, 'AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR');
    assert.ok(execInit != null, 'const AUDIT_INTEGRITY_MONITOR_EXECUTION_ERROR must exist');
    assert.ok(
      isExactStringLiteralValue(execInit, 'audit-integrity-monitor failed'),
      `execution error initializer must be exact literal, got ${execInit}`,
    );
  });

  it('13. server + web explicit 5 files: zero monitor wiring/string/API/import', async () => {
    // server + 3 web + error-codes (no monitor registry import surface)
    const zeroTargets = [
      PATHS.server,
      PATHS.webApp,
      PATHS.webIndex,
      PATHS.webStyles,
      PATHS.errorCodes,
    ];
    assert.equal(zeroTargets.length, 5);
    for (const abs of zeroTargets) {
      const text = await readText(abs);
      assert.equal(text.includes('audit-integrity-monitor'), false, abs);
      assert.equal(text.includes('runAuditIntegrityMonitor'), false, abs);
      assert.equal(text.includes('formatAuditIntegrityMonitorReportJson'), false, abs);
      assert.equal(text.includes('auditIntegrityMonitorExitCode'), false, abs);
      assert.equal(text.includes('audit-integrity-monitor.js'), false, abs);
      if (abs.endsWith('.js')) {
        const specs = collectStaticImportSpecifiers(text);
        assert.equal(
          specs.some((s) => s.includes('audit-integrity-monitor')),
          false,
          abs,
        );
      }
    }
  });

  it('14. monitor has no setInterval/setTimeout/setImmediate/worker/background handle/process.argv', async () => {
    const src = await readText(PATHS.monitor);
    const masked = maskJsNonCode(src);
    assert.equal(/\bsetInterval\b/.test(masked), false);
    assert.equal(/\bsetTimeout\b/.test(masked), false);
    assert.equal(/\bsetImmediate\b/.test(masked), false);
    assert.equal(/\bWorker\b/.test(masked), false);
    assert.equal(/\bworker_threads\b/.test(masked), false);
    assert.equal(/\bprocess\.argv\b/.test(masked), false);
    assert.equal(/\bBackground\b/.test(masked), false);
  });

  it('15. no alert spool path/capability on source targets; capability-level (not blind substring) for docs', async () => {
    // Assembled at runtime so this suite does not embed full adjacent path literals.
    const alertSpoolPath = ['alert', 'spool'].join('-');
    const monitorAlertsPath = ['monitor', 'alerts'].join('-');
    const sourceTargets = [
      PATHS.monitor,
      PATHS.agent,
      PATHS.server,
      PATHS.webApp,
      PATHS.webIndex,
      PATHS.webStyles,
      PATHS.c1Inspect,
      PATHS.c2Monitor,
      PATHS.c3Agent,
      // c4Scan scanned for assembled needle only (may discuss join pattern)
      PATHS.c4Scan,
    ];
    for (const abs of sourceTargets) {
      const text = await readText(abs);
      // Literal path/capability needles only on source/test targets (runtime join)
      assert.equal(text.includes(alertSpoolPath), false, abs);
      assert.equal(text.includes(monitorAlertsPath), false, abs);
      if (abs.endsWith('.js') && /\/src\//.test(abs)) {
        const masked = maskJsNonCode(text);
        assert.equal(/\balertSpool\b/.test(masked), false, abs);
        assert.equal(/\bwriteAlert\b/.test(masked), false, abs);
        assert.equal(/\bspoolWriter\b/.test(masked), false, abs);
        assert.equal(hasCallSite(text, 'writeAlertSpool'), false);
      }
    }

    // Docs may discuss rejected spool options with negation — capability claim, not blind path.
    for (const abs of [PATHS.monitorDesign, PATHS.monitorPlan]) {
      const text = await readText(abs);
      assertHonestyPhraseQualified(text, 'remote alert delivered', abs);
    }
  });

  it('16. ERROR_CODES exact 61; monitor does not import registry', async () => {
    assert.equal(Object.keys(ERROR_CODES).length, 61);
    const src = await readText(PATHS.monitor);
    const specs = collectStaticImportSpecifiers(src);
    assert.equal(specs.includes('./error-codes.js'), false);
    assert.equal(/\berror-codes\.js\b/.test(maskJsNonCode(src)), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. runtime concurrency / zero-write
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 C: runtime concurrency / zero-write', () => {
  it('17. active dual-write writer + monitor: no mid-prepared report; then healthy after release', async () => {
    await withTempRoot('active-writer', async (root) => {
      await ensureHealthyIdle(root);
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_AFTER_EVENTS_WRITE,
      } = await loadCoordinator();
      const { runAuditIntegrityMonitor } = await loadMonitor();

      let releaseHook;
      const gate = new Promise((resolve) => {
        releaseHook = resolve;
      });
      let signalEntered;
      const entered = new Promise((resolve) => {
        signalEntered = resolve;
      });

      const writerP = appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }, {
        [DUAL_WRITE_TEST_AFTER_EVENTS_WRITE]: async () => {
          signalEntered();
          await gate;
        },
      });

      await withTimeout(entered, 2000, 'hook-enter');

      const monP = runAuditIntegrityMonitor(root);
      // Brief wait: monitor must not complete while real writer holds queue (prepared mid-state).
      let early = false;
      await Promise.race([
        monP.then((report) => {
          early = true;
          assert.notEqual(
            report.dualWriteState,
            'prepared',
            'must never report mid-prepared while active writer holds lease',
          );
          throw new Error('monitor-completed-while-writer-paused');
        }),
        delay(80),
      ]);
      assert.equal(early, false, 'monitor must still be pending while writer paused');

      releaseHook();
      const written = await withTimeout(writerP, 2000, 'writer-finish');
      assert.ok(written);

      const report = await withTimeout(monP, 2000, 'monitor-after-writer');
      assert.equal(report.status, 'healthy');
      assert.equal(report.code, 'healthy');
      assert.equal(report.dualWriteState, 'idle');
      assert.ok(HEALTHY_RELS.has(report.relationship), `rel=${report.relationship}`);
      assert.equal(report.reasonCode, null);
      assert.equal(report.recoveryRequired, false);

      // Final layout only: no extra tmp/spool/bypass siblings.
      // Note: writer legitimately mutates the audit triple during this window (prepared→idle),
      // so cross-window byte equality is NOT asserted here. Byte zero-write of monitor-only
      // paths is proven independently by #18/#19/#22/#24–#30 snapshots.
      const snap = await snapshotRootAndAuditTriple(root);
      assert.deepEqual(snap.rootEntries.entries, ['audit']);
      assert.deepEqual(
        snap.auditEntries.entries,
        [
          'events.jsonl',
          'integrity-dual-write-state.json',
          'integrity-journal.jsonl',
        ].sort(),
      );
      assert.equal(snap.state.exists, true);
      assert.equal(snap.state.type, 'file');
      assert.equal(snap.journal.exists, true);
      assert.equal(snap.journal.type, 'file');
      assert.equal(snap.events.exists, true);
      assert.equal(snap.events.type, 'file');
    });
  });

  it('18. failed writer after-prepared leftover: recovery-required; bytes identity before/after monitor', async () => {
    await withTempRoot('crash-prep', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const before = await snapshotRootAndAuditTriple(root);
      assert.equal(before.state.exists, true);

      const report = await runMonitor(root);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'recovery-required');
      assert.equal(report.dualWriteState, 'prepared');
      assert.equal(report.relationship, null);
      assert.equal(report.recoveryRequired, true);
      assert.equal(report.reasonCode, null);

      const after = await snapshotRootAndAuditTriple(root);
      assertSnapshotEqual(before, after, 'prepared-crash');
      // existence + size + sha256 of all three files
      for (const key of ['state', 'journal', 'events']) {
        assert.equal(after[key].exists, before[key].exists, key);
        assert.equal(after[key].size, before[key].size, key);
        assert.equal(after[key].sha256, before[key].sha256, key);
      }
    });
  });

  it('19. 50 parallel runAuditIntegrityMonitor same root: all complete; deep equal except checkedAt; healthy; bytes stable', async () => {
    await withTempRoot('parallel50', async (root) => {
      await ensureHealthyIdle(root);
      const before = await snapshotRootAndAuditTriple(root);
      const { runAuditIntegrityMonitor } = await loadMonitor();
      const reports = await withTimeout(
        Promise.all(Array.from({ length: 50 }, () => runAuditIntegrityMonitor(root))),
        5000,
        'parallel50',
      );
      assert.equal(reports.length, 50);
      const normalized = reports.map(stripCheckedAt);
      for (const r of reports) {
        assert.equal(r.status, 'healthy');
        assert.equal(r.code, 'healthy');
        assert.equal(r.reasonCode, null);
        assert.ok(HEALTHY_RELS.has(r.relationship));
      }
      for (let i = 1; i < normalized.length; i += 1) {
        assert.deepEqual(normalized[i], normalized[0]);
      }
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'parallel50');
    });
  });

  it('20. cross-root parallel (≥8 roots × multi monitor) no deadlock/crosstalk; each healthy; bytes stable', async () => {
    const roots = [];
    try {
      for (let i = 0; i < 8; i += 1) {
        roots.push(await mkdtemp(join(tmpdir(), `linke-aim-c4-xroot-${i}-`)));
      }
      for (const root of roots) {
        await ensureHealthyIdle(root);
      }
      const befores = await Promise.all(roots.map((r) => snapshotRootAndAuditTriple(r)));
      const { runAuditIntegrityMonitor } = await loadMonitor();
      const tasks = [];
      for (const root of roots) {
        for (let k = 0; k < 3; k += 1) {
          tasks.push(runAuditIntegrityMonitor(root).then((report) => ({ root, report })));
        }
      }
      const results = await withTimeout(Promise.all(tasks), 8000, 'cross-root');
      assert.equal(results.length, 24);
      for (const { report } of results) {
        assert.equal(report.status, 'healthy');
        assert.equal(report.code, 'healthy');
        assert.ok(HEALTHY_RELS.has(report.relationship));
      }
      // Per-root: all reports for that root deep-equal except checkedAt
      for (const root of roots) {
        const group = results.filter((x) => x.root === root).map((x) => stripCheckedAt(x.report));
        for (let i = 1; i < group.length; i += 1) {
          assert.deepEqual(group[i], group[0]);
        }
      }
      const afters = await Promise.all(roots.map((r) => snapshotRootAndAuditTriple(r)));
      for (let i = 0; i < roots.length; i += 1) {
        assertSnapshotEqual(befores[i], afters[i], `cross-root-${i}`);
      }
    } finally {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
    }
  });

  it('21. nested enqueue under same-root outer lease rejects quickly as SafeDataFileError; top-level still healthy', async () => {
    await withTempRoot('nested', async (root) => {
      await ensureHealthyIdle(root);
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const { enqueueAuditIntegrityWriteTask } = await import(
        '../src/audit-integrity-write-queue.js'
      );
      const { runAuditIntegrityMonitor } = await loadMonitor();
      const resolved = await assertSafeDataRoot(root);

      /** @type {unknown} */
      let nestedErr = null;
      /** @type {number|null} */
      let elapsedMs = null;
      await withTimeout(
        enqueueAuditIntegrityWriteTask(resolved, async () => {
          const t0 = Date.now();
          try {
            // Safety cap only — must not be the success path for "fail-closed".
            await withTimeout(
              runAuditIntegrityMonitor(root),
              2000,
              'nested-monitor-safety-cap',
            );
            nestedErr = new Error('nested-monitor-should-have-rejected');
          } catch (e) {
            elapsedMs = Date.now() - t0;
            nestedErr = e;
          }
        }),
        3000,
        'outer-lease',
      );

      assert.ok(
        nestedErr instanceof SafeDataFileError,
        `expected SafeDataFileError, got ${nestedErr && nestedErr.constructor && nestedErr.constructor.name}: ${nestedErr && nestedErr.message}`,
      );
      assert.equal(nestedErr.name, 'SafeDataFileError');
      assert.notEqual(
        String(nestedErr.message),
        'timeout:nested-monitor-safety-cap:2000ms',
        'timeout must not masquerade as nested fail-closed',
      );
      assert.equal(
        String(nestedErr.message).startsWith('timeout:'),
        false,
        `must not be timeout-shaped: ${nestedErr.message}`,
      );
      // Queue nested reject is synchronous fail-closed (well under 200ms even on slow CI).
      assert.equal(typeof elapsedMs, 'number');
      assert.ok(
        elapsedMs < 200,
        `nested fail-closed must be quick; elapsedMs=${elapsedMs}`,
      );

      const report = await withTimeout(
        runAuditIntegrityMonitor(root),
        2000,
        'top-level-after-nested',
      );
      assert.equal(report.status, 'healthy');
      assert.equal(report.code, 'healthy');
    });
  });

  it('21b. canary: never-settling promise is only a timeout, never a quick fail-closed', async () => {
    const never = new Promise(() => {});
    const t0 = Date.now();
    /** @type {unknown} */
    let err = null;
    try {
      await withTimeout(never, 60, 'nested-monitor');
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    assert.ok(err instanceof Error);
    assert.match(String(err.message), /^timeout:nested-monitor:60ms$/);
    assert.equal(err instanceof SafeDataFileError, false);
    // This path is a hang-guard, not proof of nested reject — elapsed ≈ timeout budget.
    assert.ok(elapsed >= 50, `timeout path elapsed=${elapsed}`);
    // Explicit: old assert.rejects(withTimeout(...)) would pass here and false-green.
  });

  it('22. repeat same fixture twice: deep equal except checkedAt; key order; frozen; zero-write', async () => {
    await withTempRoot('repeat', async (root) => {
      await ensureHealthyIdle(root);
      const before = await snapshotRootAndAuditTriple(root);
      const r1 = await runMonitor(root);
      const r2 = await runMonitor(root);
      assert.deepEqual(stripCheckedAt(r1), stripCheckedAt(r2));
      assert.deepEqual(Object.keys(r1), Object.keys(r2));
      assert.ok(Object.isFrozen(r1));
      assert.ok(Object.isFrozen(r2));
      assert.deepEqual(Object.keys(r1), [
        'schemaVersion',
        'status',
        'code',
        'checkedAt',
        'dualWriteState',
        'relationship',
        'recoveryRequired',
        'alertRequired',
        'nextAction',
        'reasonCode',
      ]);
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'repeat');
    });
  });

  it('23. RootFail nonexistent: no root create; io-alert; zero write', async () => {
    const missing = join(
      tmpdir(),
      `linke-aim-c4-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const before = await snapshotPathEntry(missing);
    assert.equal(before.exists, false);
    const report = await runMonitor(missing);
    assert.equal(report.status, 'alert');
    assert.equal(report.code, 'io-alert');
    assert.equal(report.dualWriteState, 'unknown');
    assert.equal(report.relationship, null);
    assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });
    const after = await snapshotPathEntry(missing);
    assert.deepEqual(after, before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. full matrix zero-write helper
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 D: full matrix zero-write snapshots + correct codes', () => {
  it('24. cold existing empty root: no files created; code uninitialized', async () => {
    await withTempRoot('cold', async (root) => {
      const before = await snapshotRootAndAuditTriple(root);
      assert.equal(before.root.exists, true);
      assert.equal(before.root.type, 'dir');
      assert.equal(before.state.exists, false);
      assert.equal(before.journal.exists, false);
      assert.equal(before.events.exists, false);
      const report = await runMonitor(root);
      assert.equal(report.code, 'uninitialized');
      assert.equal(report.status, 'alert');
      assert.equal(report.dualWriteState, 'missing');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, null);
      assert.equal(report.nextAction, 'initialize-via-production-write');
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'cold');
      const entries = await readdir(root);
      assert.deepEqual(entries, []);
    });
  });

  it('25. healthy idle zero-write; code healthy', async () => {
    await withTempRoot('healthy-zw', async (root) => {
      await ensureHealthyIdle(root);
      const before = await snapshotRootAndAuditTriple(root);
      const report = await runMonitor(root);
      assert.equal(report.code, 'healthy');
      assert.equal(report.status, 'healthy');
      assert.equal(report.dualWriteState, 'idle');
      assert.ok(HEALTHY_RELS.has(report.relationship));
      assert.equal(report.reasonCode, null);
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'healthy');
    });
  });

  it('26. prepared crash leftover zero-write; recovery-required', async () => {
    await withTempRoot('prep-zw', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const before = await snapshotRootAndAuditTriple(root);
      const report = await runMonitor(root);
      assert.equal(report.code, 'recovery-required');
      assert.equal(report.dualWriteState, 'prepared');
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'prepared');
    });
  });

  it('27. invalid state JSON/schema zero-write; integrity-alert + state-invalid', async () => {
    await withTempRoot('bad-state', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{not-json\n', { mode: 0o600 });
      const before = await snapshotRootAndAuditTriple(root);
      const report = await runMonitor(root);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'invalid');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'invalid-state');
    });
  });

  it('28. state-missing receipt success zero-write; code state-missing', async () => {
    await withTempRoot('s-miss', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(eventsAbs(root), eventLine(EVENT_A), { mode: 0o600 });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      const before = await snapshotRootAndAuditTriple(root);
      const report = await runMonitor(root);
      assert.equal(report.code, 'state-missing');
      assert.equal(report.dualWriteState, 'missing');
      assert.equal(report.reasonCode, null);
      assert.equal(report.relationship, 'equal');
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'state-missing');
    });
  });

  it('29. cursor mismatch fixture zero-write; integrity-alert + cursor-mismatch', async () => {
    await withTempRoot('cursor-mm', async (root) => {
      await ensureHealthyIdle(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const before = await snapshotRootAndAuditTriple(root);
      const report = await runMonitor(root);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'cursor-mm');
    });
  });

  it('30. idle empty attention fixture zero-write; integrity-alert + relationship empty', async () => {
    await withTempRoot('idle-empty', async (root) => {
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAuditIntegrityDualWrite(root);
      const before = await snapshotRootAndAuditTriple(root);
      const report = await runMonitor(root);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, 'empty');
      assert.equal(report.reasonCode, null);
      assert.equal(report.nextAction, 'investigate-integrity');
      assertSnapshotEqual(before, await snapshotRootAndAuditTriple(root), 'idle-empty');
    });
  });

  it('30b. canary: snapshot rootEntries/auditEntries detect new sibling file (not hash-only)', async () => {
    await withTempRoot('snap-canary', async (root) => {
      await ensureHealthyIdle(root);
      const before = await snapshotRootAndAuditTriple(root);
      assert.equal(before.rootEntries.exists, true);
      assert.ok(Array.isArray(before.rootEntries.entries));
      assert.equal(before.auditEntries.exists, true);
      assert.ok(Array.isArray(before.auditEntries.entries));
      // Unrelated bypass file under controlled temp root — must break equality.
      await writeFile(join(root, 'spool-extra-bypass.txt'), 'not-an-audit-store\n', {
        mode: 0o600,
      });
      const after = await snapshotRootAndAuditTriple(root);
      assert.notDeepEqual(after, before, 'new root sibling must change snapshot');
      assert.notDeepEqual(after.rootEntries, before.rootEntries);
      // Triple file hashes may still match — directory listing is the detector.
      assert.deepEqual(after.state, before.state);
      assert.deepEqual(after.journal, before.journal);
      assert.deepEqual(after.events, before.events);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. honesty / limitations
// ═══════════════════════════════════════════════════════════════════════════

describe('C4 E: honesty / limitations / allowlist', () => {
  it('31. forbidden compound runtime needle zero on allowlisted targets; suite itself clean', async () => {
    const needle = forbiddenTamperEvidentNeedle();
    assert.equal(needle, ['tamper', 'evident'].join('-'));
    const targets = [
      PATHS.monitor,
      PATHS.agent,
      PATHS.server,
      PATHS.webApp,
      PATHS.webIndex,
      PATHS.webStyles,
      PATHS.monitorDesign,
      PATHS.monitorPlan,
      PATHS.c1Inspect,
      PATHS.c2Monitor,
      PATHS.c3Agent,
      PATHS.c4Scan,
      PATHS.dualWriteScans,
    ];
    for (const abs of targets) {
      const text = await readText(abs);
      assert.equal(text.includes(needle), false, `needle in ${abs}`);
    }
  });

  it('32. honesty phrases clause-local on monitor/agent/C1-C3/C0; signature ceiling alone allowed', async () => {
    // c4Scan intentionally holds positive canary fixtures for the clause scanner;
    // it must not self-trip (same pattern as dual-write C6 scans).
    const targets = [
      PATHS.monitor,
      PATHS.agent,
      PATHS.c1Inspect,
      PATHS.c2Monitor,
      PATHS.c3Agent,
      PATHS.monitorDesign,
      PATHS.monitorPlan,
    ];
    for (const abs of targets) {
      const text = await readText(abs);
      for (const phrase of HONESTY_PHRASES) {
        assertHonestyPhraseQualified(text, phrase, abs);
      }
    }
    // Ceiling may appear (docs); only that exact string is the positive signature
    assert.equal(typeof SIGNATURE_CEILING, 'string');
    assert.ok(SIGNATURE_CEILING.startsWith('V1.38 '));
  });

  it('33. signature finder canaries: hostile V1.38…implementation caught; exact ceiling and Not pass', () => {
    assert.equal(
      SIGNATURE_CEILING,
      'V1.38 read-only audit integrity run-once monitor/alert implementation',
    );
    // Hostile competing positive signatures (must not false-green).
    assert.equal(
      findUnqualifiedV138SignatureLines(
        'V1.38 production monitoring ready implementation',
      ).length,
      1,
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        'V1.38 remote alert delivered implementation',
      ).length,
      1,
    );
    // Heading must not blanket-exempt overclaim (was false-negative).
    assert.equal(
      findUnqualifiedV138SignatureLines(
        '## V1.38 production monitoring ready implementation',
      ).length,
      1,
      'overclaim markdown heading must still be an offender',
    );
    // Case-insensitive implementation token (was false-negative).
    assert.equal(
      findUnqualifiedV138SignatureLines(
        'V1.38 production monitoring ready IMPLEMENTATION',
      ).length,
      1,
      'ALL-CAPS IMPLEMENTATION must still be an offender',
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        'V1.38 production monitoring ready Implementation',
      ).length,
      1,
      'Title-case Implementation overclaim must still be an offender',
    );
    // Ceiling then competing signature in a later clause — must catch the second.
    assert.equal(
      findUnqualifiedV138SignatureLines(
        `${SIGNATURE_CEILING}; V1.38 Gold production implementation`,
      ).length,
      1,
      'exact ceiling must not shelter a later competing signature clause',
    );
    // Exact ceiling passes (plain, meta prefix, markdown/code wrappers).
    assert.equal(
      findUnqualifiedV138SignatureLines(SIGNATURE_CEILING).length,
      0,
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        `Signature ceiling: ${SIGNATURE_CEILING}`,
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        `\`${SIGNATURE_CEILING}\``,
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        `> \`${SIGNATURE_CEILING}\``,
      ).length,
      0,
    );
    // Hostile plan-title: same "... Implementation Plan" shell but wrong core words.
    // Must NOT be exempted by a loose Implementation Plan allowlist.
    assert.equal(
      findUnqualifiedV138SignatureLines(
        '# V1.38 Production Monitoring Ready Implementation Plan',
      ).length,
      1,
      'overclaim Implementation Plan heading must still be an offender',
    );
    // Real allowlisted plan title (exact core words) may pass; format-only variants ok.
    assert.equal(
      findUnqualifiedV138SignatureLines(
        '# V1.38 Read-Only Audit Integrity Run-Once Monitor/Alert Implementation Plan',
      ).length,
      0,
      'exact plan meta title is allowed',
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        '  ##  v1.38  read-only  audit  integrity  run-once  monitor/alert  implementation  plan  ',
      ).length,
      0,
      'plan meta title allows heading-level/case/whitespace format variants only',
    );
    // Negative / Not passes.
    assert.equal(
      findUnqualifiedV138SignatureLines(
        'Not V1.38 production monitoring ready implementation',
      ).length,
      0,
    );
    assert.equal(
      findUnqualifiedV138SignatureLines(
        'BLOCKED: V1.38 remote alert delivered implementation',
      ).length,
      0,
    );
  });

  it('33b. signature finder on allowlisted C0/C1/C2/C3/monitor/agent (C4 self excluded: holds hostile canary fixtures)', async () => {
    // C4 scan file intentionally embeds hostile signature canary strings in test 33;
    // scanning self would self-trip. Allowlist covers production + C0–C3 surfaces.
    const targets = [
      PATHS.monitor,
      PATHS.agent,
      PATHS.c1Inspect,
      PATHS.c2Monitor,
      PATHS.c3Agent,
      PATHS.monitorDesign,
      PATHS.monitorPlan,
      PATHS.dualWriteScans,
    ];
    for (const abs of targets) {
      const text = await readText(abs);
      assertNoUnqualifiedV138Signatures(text, abs);
    }
    // Design still documents the exact ceiling (positive allowed form).
    const design = await readText(PATHS.monitorDesign);
    assert.ok(
      design.includes(SIGNATURE_CEILING),
      'design must include exact signature ceiling literal',
    );
  });

  it('34. multi-process limitation present in design/plan: NOT guaranteed / no lock; not delivered', async () => {
    // Hostile: bare positive "multi-process lock" must not satisfy limitation assertion,
    // and honesty scanner must cover the shorter phrase (not only "… exclusive lock").
    const positiveDeliver = 'we deliver multi-process lock';
    assert.equal(
      /not\*?\*?\s*multi-process exclusive lock/i.test(positiveDeliver)
        || /not multi-process safe/i.test(positiveDeliver)
        || /in-process queue only/i.test(positiveDeliver)
        || /no multi-process/i.test(positiveDeliver)
        || /NOT guaranteed/i.test(positiveDeliver)
        || /不保证/.test(positiveDeliver)
        || /仍无/.test(positiveDeliver),
      false,
      'positive multi-process lock delivery must fail limitation documentation check',
    );
    assert.equal(
      findUnqualifiedHonestyPhraseLines(positiveDeliver, 'multi-process lock').length,
      1,
    );

    const design = await readText(PATHS.monitorDesign);
    const plan = await readText(PATHS.monitorPlan);
    for (const text of [design, plan]) {
      assert.ok(
        /NOT guaranteed/i.test(text)
          || /不保证/.test(text)
          || /not\*?\*?\s*multi-process/i.test(text)
          || /not multi-process/i.test(text),
        'must document multi-process limitation',
      );
      // Accept only explicit negative/limit forms — no bare /multi-process lock/ fallback.
      assert.ok(
        /not\*?\*?\s*multi-process exclusive lock/i.test(text)
          || /not multi-process safe/i.test(text)
          || /in-process queue only/i.test(text)
          || /no multi-process/i.test(text)
          || /not multi-process lock/i.test(text)
          || /NOT guaranteed/i.test(text)
          || /不保证/.test(text)
          || /仍无/.test(text),
        'must document no multi-process lock with explicit negation/limit wording',
      );
      assertHonestyPhraseQualified(text, 'multi-process exclusive lock', 'multi-process');
      assertHonestyPhraseQualified(text, 'multi-process lock', 'multi-process-lock');
    }
  });

  it('35. help honesty: extract real printUsage body (no silent whole-file fallback)', async () => {
    const agent = await readText(PATHS.agent);
    // Agent help SoT is printUsage — must extract successfully (not null / not whole file).
    assert.equal(extractFunctionBody(agent, 'printHelp'), null, 'printHelp must not exist');
    const helpBody = extractFunctionBody(agent, 'printUsage');
    assert.ok(helpBody != null, 'printUsage body must extract');
    assert.ok(helpBody.length > 0);
    assert.ok(
      helpBody.length < agent.length / 2,
      'printUsage body must not silently equal whole agent source',
    );
    assert.ok(
      /audit-integrity-monitor/.test(helpBody),
      'printUsage must list audit-integrity-monitor',
    );

    // Help-specific delivery claims: raw body only (strings inside printUsage).
    assert.equal(/remote\s+alert\s+delivered/i.test(helpBody), false);
    assert.equal(/production\s+monitoring\s+ready/i.test(helpBody), false);
    assert.equal(/managed\s+scheduler\s+delivered/i.test(helpBody), false);
    assert.equal(/T6d\.3 complete/i.test(helpBody), false);
    assert.equal(/M6d Exit/i.test(helpBody), false);
    for (const phrase of [
      'remote alert delivered',
      'production monitoring ready',
      'T6d.3 complete',
      'M6d Exit',
    ]) {
      assertHonestyPhraseQualified(helpBody, phrase, 'printUsage-body');
    }

    // Supplemental whole-agent honesty (not a substitute for printUsage extraction).
    for (const phrase of [
      'remote alert delivered',
      'production monitoring ready',
      'T6d.3 complete',
      'M6d Exit',
    ]) {
      assertHonestyPhraseQualified(agent, phrase, 'agent-full');
    }
  });

  it('36. C6/C7 explicit allowlist includes monitor source/C1/C2/C3/C4/C0/agent/server/web', () => {
    // Living allowlist for future honesty/isolation scans — must include C4 surfaces.
    const C6_C7_ALLOWLIST = Object.freeze([
      PATHS.monitor,
      PATHS.dualWrite,
      PATHS.writeQueue,
      PATHS.agent,
      PATHS.server,
      PATHS.webApp,
      PATHS.webIndex,
      PATHS.webStyles,
      PATHS.errorCodes,
      PATHS.c1Inspect,
      PATHS.c2Monitor,
      PATHS.c3Agent,
      PATHS.c4Scan,
      PATHS.dualWriteScans,
      PATHS.monitorDesign,
      PATHS.monitorPlan,
    ]);
    const requiredSuffixes = [
      'src/audit-integrity-monitor.js',
      'test/audit-integrity-dual-write-readonly-inspect.test.js',
      'test/audit-integrity-monitor.test.js',
      'test/agent-audit-integrity-monitor.test.js',
      'test/audit-integrity-monitor-scans.test.js',
      'docs/superpowers/specs/2026-07-19-audit-integrity-monitor-alert-design.md',
      'docs/superpowers/plans/2026-07-19-audit-integrity-monitor-alert.md',
      'src/agent.js',
      'src/server.js',
      'src/web/app.js',
      'src/web/index.html',
      'src/web/styles.css',
    ];
    for (const suf of requiredSuffixes) {
      assert.ok(
        C6_C7_ALLOWLIST.some((p) => p.endsWith(suf) || p.includes(suf)),
        `allowlist missing ${suf}`,
      );
    }
    assert.ok(C6_C7_ALLOWLIST.length >= requiredSuffixes.length);
  });
});
