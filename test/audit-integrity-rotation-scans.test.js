/**
 * V1.43 Task 9 Q1–Q4: security scans, version and honest release surface for
 * the explicit crash-recoverable audit integrity rotation foundation.
 *
 * Static/structural scans only. Reads explicit allowlisted file paths
 * (import.meta.dirname → repo root). No git. No network. No secrets.
 *
 * Q1: no automatic timer/scheduler/threshold/event-listener/microtask/fs-watch
 *     trigger, no HTTP route, no Web button/path, and no archive
 *     deletion/overwrite vocabulary in the V1.43 rotation feature (line-filter
 *     plus lexically-masked code scans, with hostile canaries proving the
 *     detectors catch representative bypass categories). The positive
 *     explicit CLI commands (audit-integrity-rotate /
 *     audit-integrity-rotation-recover) are allowed and asserted present;
 *     archive publication must stay create-exclusive (safeCreateExclusiveText
 *     real call site) while live cutover keeps safeAtomicWriteBytes/Text.
 * Q2: import direction — lexical static-import extractor (not blinded by
 *     comment/string/regex/template noise, proven by hostile canaries);
 *     exact closed-set static import specifiers for both rotation modules so
 *     no unlisted helper can smuggle scheduling/deletion/overwrite behavior;
 *     no dynamic import() / CommonJS require() on the rotation/state/server/
 *     web surfaces; rotation-state cannot import coordinator / audit-log /
 *     agent / monitor; server/web cannot import rotation modules or expose
 *     rotation commands; the production append gate executes before
 *     dual-state interpretation inside the exact write-queue lease callback
 *     (brace-balanced extraction, each call exactly once, gate ordered first).
 *     This textual ordering is a structural contract only — the runtime proof
 *     that every nonterminal status (CP0/CP4/CP5/CP6) blocks ordinary append
 *     without auto-recovery (G2) and that the monitor stays read-only /
 *     non-recovering (G6) is separately covered by
 *     test/audit-integrity-rotation-gates.test.js in the full standard suite.
 * Q3: exact six rotation error registry values; exact total registry count 94;
 *     receipt/error output path-free (no cause/stack/raw-event/absolute-path).
 * Q4: exact V1.43 signature and negative boundaries on the current README /
 *     gold-readiness surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import { buildGoldReadinessReport } from '../src/gold-readiness.js';

const REPO_ROOT = join(import.meta.dirname, '..');

/** Explicit allowlisted source surfaces — never recursive scans. */
const PATHS = Object.freeze({
  rotation: join(REPO_ROOT, 'src/audit-integrity-rotation.js'),
  rotationState: join(REPO_ROOT, 'src/audit-integrity-rotation-state.js'),
  dualWrite: join(REPO_ROOT, 'src/audit-integrity-dual-write.js'),
  auditLog: join(REPO_ROOT, 'src/audit-log.js'),
  agent: join(REPO_ROOT, 'src/agent.js'),
  server: join(REPO_ROOT, 'src/server.js'),
  webApp: join(REPO_ROOT, 'src/web/app.js'),
  webIndex: join(REPO_ROOT, 'src/web/index.html'),
  readme: join(REPO_ROOT, 'README.md'),
});

/** Exact current V1.44 real NAS acceptance PASS signature. */
const V144_SIGNATURE =
  'V1.44 real NAS acceptance PASS';

/** Exact historical V1.43 signature — retained rotation foundation. */
const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';

/** Exact historical V1.42 signature — retained G0c base; must not be erased. */
const V142_SIGNATURE =
  'V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation';

/** Exact six V1.43 rotation error registry values (key → kebab value). */
const EXPECTED_ROTATION_ERROR_CODES = Object.freeze({
  AUDIT_INTEGRITY_ROTATION_STATE_INVALID: 'audit-integrity-rotation-state-invalid',
  AUDIT_INTEGRITY_ROTATION_IO_ERROR: 'audit-integrity-rotation-io-error',
  AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED:
    'audit-integrity-rotation-precondition-failed',
  AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED:
    'audit-integrity-rotation-recovery-required',
  AUDIT_INTEGRITY_ROTATION_CONFLICT: 'audit-integrity-rotation-conflict',
  AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED:
    'audit-integrity-rotation-bounds-exceeded',
});

/** Exact total registry count: 88 (V1.42 G0c) + 6 V1.43 rotation codes. */
const EXPECTED_REGISTRY_COUNT = 94;

/** Exact public CLI rotation receipt key order (freezeReceipt contract). */
const EXPECTED_RECEIPT_KEYS = Object.freeze([
  'state',
  'rotationId',
  'previousGenerationId',
  'generationId',
  'archiveRelativePath',
  'archiveManifestDigest',
  'previousRecordCount',
  'newRecordCount',
  'relationship',
]);

/** Exact read-only rotation observation key order. */
const EXPECTED_OBSERVATION_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'dualWriteState',
  'relationship',
  'reasonCode',
]);

/**
 * Automatic trigger / scheduler vocabulary forbidden in rotation code:
 * timers, cron/scheduler/threshold wording, microtask deferral
 * (process.nextTick / queueMicrotask), fs watch (watch / watchFile /
 * chokidar), worker_threads / MessagePort, addEventListener, and process/stdin
 * event-listener trigger forms. Legitimate synchronous/manual CLI code stays
 * allowed (Q1 hostile canaries prove both directions).
 */
const AUTOMATIC_TRIGGER_RE =
  /\bsetInterval\b|\bsetTimeout\b|\bsetImmediate\b|\bsetScheduler\b|node:timers|\bcron\b|schedul|threshold|\bprocess\.nextTick\b|\bqueueMicrotask\b|\bwatch(?:File)?\b|\bchokidar\b|\bworker_threads\b|\bMessagePort\b|\baddEventListener\b|\bprocess\.(?:on|once|addListener)\s*\(|\bstdin\.(?:on|once|addListener)\s*\(/i;

/** HTTP/server vocabulary forbidden in rotation feature code. */
const HTTP_SURFACE_RE = /\bhttps?\b|createServer|\bfetch\s*\(|express/i;

/**
 * Archive deletion / overwrite vocabulary forbidden in rotation code:
 * unlink/rm/rmdir/rename (and Sync forms), fs.rm, delete, truncate/ftruncate,
 * overwrite-capable writeFile/writeFileSync/createWriteStream, remove,
 * overwrite. The legitimate live-cutover safeAtomicWriteBytes/Text and the
 * create-exclusive safeCreateExclusiveText archive publication stay allowed
 * (Q1 hostile canaries prove the negative direction).
 */
const DELETION_RE =
  /\bunlink(?:Sync)?\b|\brmSync\b|\bfs\.rm\b|\brm\s*\(|\brmdir(?:Sync)?\b|\brename(?:Sync)?\b|\bdelete\b|\btruncate(?:Sync)?\b|\bftruncate(?:Sync)?\b|\bwriteFile(?:Sync)?\b|\bcreateWriteStream\b|\bremove(?:Sync)?\b|\boverwrite\b/i;

/** Rotation command/API vocabulary forbidden outside the Agent CLI. */
const ROTATION_SURFACE_VOCAB_RE =
  /audit-integrity-rotate|audit-integrity-rotation|rotateAuditIntegrity|recoverAuditIntegrityRotation/i;

/** Dynamic import() forbidden on the Q1/Q2 rotation/state/server/web surfaces. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

/** CommonJS require() forbidden on the Q1/Q2 rotation/state/server/web surfaces. */
const REQUIRE_RE = /\brequire\s*\(/;

/**
 * Exact closed-set static import specifiers for the rotation coordinator
 * (source order). The coordinator legitimately imports the dual-write /
 * journal / cross-store / state helpers listed here; any new unlisted helper
 * (scheduling, deletion, overwrite, fs access) fails this assertion first.
 */
const EXPECTED_ROTATION_IMPORTS = Object.freeze([
  'node:crypto',
  'node:util',
  './safe-data-files.js',
  './error-codes.js',
  './audit-integrity-write-queue.js',
  './audit-integrity-dual-write.js',
  './audit-integrity-dual-write-state.js',
  './audit-integrity-rotation-state.js',
  './audit-integrity-journal.js',
  './audit-integrity-cross-store.js',
  './audit-event-schema.js',
]);

/**
 * Exact lower-level closed-set static import specifiers for rotation-state
 * (source order). Retained narrow: no coordinator/journal/audit-log/agent/
 * monitor and no new helper above this list.
 */
const EXPECTED_ROTATION_STATE_IMPORTS = Object.freeze([
  'node:crypto',
  'node:util',
  './safe-data-files.js',
  './error-codes.js',
  './audit-event-schema.js',
  './audit-integrity-write-queue.js',
]);

/** Production append-path function names locked by the Q2 structural gate. */
const APPEND_COORDINATOR_FN = 'appendAuditEventWithIntegrityDualWrite';
const WRITE_QUEUE_ENQUEUE_FN = 'enqueueAuditIntegrityWriteTask';
const ROTATION_APPEND_GATE_FN = 'assertAuditIntegrityRotationAllowsAppendUnlocked';
const DUAL_WRITE_IDLE_FN = 'ensureAuditIntegrityDualWriteIdleUnlocked';
const DUAL_WRITE_COMMIT_FN = 'commitDualWriteUnlocked';

async function readAllowedSources() {
  const entries = await Promise.all(
    Object.entries(PATHS).map(async ([key, path]) => [
      key,
      await readFile(path, 'utf-8'),
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * Drop docblock / full-line comment lines so honesty prose (e.g. "not
 * scheduled rotation", "Never overwrites/deletes/renames") cannot false-trip
 * code scans. Keeps every real code line untouched.
 */
function codeLinesOnly(text) {
  return String(text)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(
        t.startsWith('/*')
        || t.startsWith('*')
        || t.startsWith('//')
      );
    })
    .join('\n');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isJsIdentPart(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Minimal JS lexical mask for scan honesty (self-contained copy of the
 * pattern proven in test/audit-integrity-dual-write-scans.test.js — no
 * cross-test import). Preserves length and newlines so indices stay aligned;
 * non-code becomes spaces. Masks: line comments, block comments, ' / "
 * strings, template *text*, and regex literals (so `/a\/\/b/` does not blind
 * later code as `//` comments). Template `${expressions}` remain code
 * (braces/calls inside expressions stay real). Not a full parser.
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
 * Handles single/double quotes and multiline imports; not blinded by
 * comment/string/regex/template noise. Does not collect dynamic import(.
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
 * Indices of real code call sites of `name` in already-masked source.
 * Comments / strings / template text / regex bodies never count.
 */
function callSiteIndices(masked, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  const indices = [];
  let m;
  while ((m = re.exec(masked)) !== null) indices.push(m.index);
  return indices;
}

/**
 * Extract the exact write-queue lease callback body of the production append
 * path: the `async (lease) => { ... }` argument of the enqueue call inside
 * the given append function body. Returns index-aligned { body, masked }
 * slices, or null when the enqueue call / arrow callback is absent.
 * Brace-balanced on lexically masked source, so comment/string braces cannot
 * truncate the callback.
 */
function extractEnqueueLeaseCallback(appendBody) {
  const text = String(appendBody);
  const masked = maskJsNonCode(text);
  const call = new RegExp(
    `\\b${escapeRegExp(WRITE_QUEUE_ENQUEUE_FN)}\\s*\\(`,
  ).exec(masked);
  if (!call) return null;
  const arrowIdx = masked.indexOf('=>', call.index + call[0].length);
  if (arrowIdx < 0) return null;
  const openBrace = masked.indexOf('{', arrowIdx + 2);
  if (openBrace < 0) return null;
  let depth = 0;
  for (let j = openBrace; j < masked.length; j += 1) {
    const ch = masked[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          body: text.slice(openBrace + 1, j),
          masked: masked.slice(openBrace + 1, j),
        };
      }
    }
  }
  return null;
}

/**
 * Slice a source segment between two exact markers (end marker excluded).
 * Both markers must exist — a missing marker is a scan failure, not a pass.
 */
function sliceSegment(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `segment start marker must exist: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `segment end marker must exist after start: ${endMarker}`);
  return text.slice(start, end);
}

/** Rotation-command surface of the Agent CLI (handlers + argv parsers). */
function rotationAgentSegments(agent) {
  const rotateCase = sliceSegment(
    agent,
    "case 'audit-integrity-rotate': {",
    "case 'audit-integrity-rotation-recover': {",
  );
  const recoverCase = sliceSegment(
    agent,
    "case 'audit-integrity-rotation-recover': {",
    "case 'heartbeat': {",
  );
  const rotateParser = sliceSegment(
    agent,
    'function parseAuditIntegrityRotateArgs(rawArgv) {',
    '\n}\n',
  );
  const recoverParser = sliceSegment(
    agent,
    'function parseAuditIntegrityRotationRecoverArgs(rawArgv) {',
    '\n}\n',
  );
  return {
    rotateCase,
    recoverCase,
    rotateParser,
    recoverParser,
    joined: `${rotateCase}\n${recoverCase}\n${rotateParser}\n${recoverParser}`,
  };
}

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

/** README current surface: current-version badge block + current version row. */
function extractReadmeCurrentSurface(readme) {
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
  assert.ok(
    currentRow,
    `README version table current row for ${LINKE_RELEASE_VERSION} must exist`,
  );
  return { badge, currentRow, currentSurface: `${badge}\n${currentRow}`, lines };
}

describe('V1.43 audit integrity rotation security scans and honest release surface', () => {
  it('Q1 exposes no automatic, HTTP, Web, scheduler, or archive deletion path', async () => {
    const sources = await readAllowedSources();

    // Dedicated rotation modules: scan real code lines only (docblock honesty
    // prose is allowed to name what is NOT delivered).
    const rotationCode = codeLinesOnly(`${sources.rotation}\n${sources.rotationState}`);
    assert.doesNotMatch(
      rotationCode,
      AUTOMATIC_TRIGGER_RE,
      'rotation modules must not contain timer/scheduler/threshold/event-listener/microtask/watch trigger code',
    );
    assert.doesNotMatch(
      rotationCode,
      HTTP_SURFACE_RE,
      'rotation modules must not contain HTTP/server code',
    );
    assert.doesNotMatch(
      rotationCode,
      DELETION_RE,
      'rotation modules must not contain archive deletion/overwrite/rename code',
    );

    // Source-aware second pass: the lexical mask also blanks inline comments
    // and strings, so honesty prose cannot false-trip and real code cannot
    // smuggle trigger/deletion vocabulary past docblock line filtering.
    const rotationMasked = maskJsNonCode(`${sources.rotation}\n${sources.rotationState}`);
    assert.doesNotMatch(
      rotationMasked,
      AUTOMATIC_TRIGGER_RE,
      'masked rotation code must not contain automatic/event trigger code',
    );
    assert.doesNotMatch(
      rotationMasked,
      DELETION_RE,
      'masked rotation code must not contain archive deletion/overwrite code',
    );

    // Hostile canaries: the trigger detector must catch representative bypass
    // categories (timers, microtask deferral, fs watch, worker/port,
    // event-listener trigger forms) while legitimate synchronous/manual code
    // stays allowed.
    for (const hostile of [
      'setTimeout(boom, 0)',
      'setImmediate(boom)',
      'process.nextTick(boom)',
      'queueMicrotask(boom)',
      "watch('audit/archive', boom)",
      "watchFile('audit/archive', boom)",
      "chokidar.watch('audit/archive')",
      "const { Worker } = await import('worker_threads')",
      'const port = new MessagePort()',
      "addEventListener('data', boom)",
      "process.on('exit', boom)",
      "process.once('SIGINT', boom)",
      "process.stdin.on('data', boom)",
      'cron.scheduleDaily(boom)',
    ]) {
      assert.match(
        hostile,
        AUTOMATIC_TRIGGER_RE,
        `trigger detector must catch representative bypass: ${hostile}`,
      );
    }
    assert.doesNotMatch(
      'await safeCreateExclusiveText(resolvedRoot, rel, raw, { mode: 0o600 });',
      AUTOMATIC_TRIGGER_RE,
      'legitimate synchronous archive write must not trip the trigger detector',
    );

    // Hostile canaries: the deletion detector must catch destructive
    // aliases/synonyms, and must NOT flag the legitimate live-cutover
    // safeAtomicWriteBytes/Text or the create-exclusive safeCreateExclusiveText.
    for (const hostile of [
      'unlinkSync(archivePath)',
      'await fs.rm(archivePath, { recursive: true })',
      'await rm(archivePath)',
      'rmdirSync(archiveDir)',
      'renameSync(archivePath, otherPath)',
      'truncateSync(archivePath)',
      'ftruncateSync(fd)',
      "writeFileSync(archivePath, 'x')",
      'createWriteStream(archivePath)',
      'delete manifest.archives',
      'await remove(archivePath)',
    ]) {
      assert.match(
        hostile,
        DELETION_RE,
        `deletion detector must catch destructive alias: ${hostile}`,
      );
    }
    for (const legit of [
      'await safeAtomicWriteText(resolvedRoot, rel, raw)',
      'await safeAtomicWriteBytes(resolvedRoot, rel, bytes)',
      'await safeCreateExclusiveText(resolvedRoot, rel, raw, { mode: 0o600 })',
    ]) {
      assert.doesNotMatch(
        legit,
        DELETION_RE,
        `legitimate cutover/create-exclusive archive API must pass: ${legit}`,
      );
    }

    // Positive controls: the scan is not vacuous — the dedicated modules exist,
    // use create-exclusive archive writes, and export the explicit entry points.
    assert.ok(
      sources.rotation.includes('safeCreateExclusiveText'),
      'rotation module must use create-exclusive archive writes (never overwrite)',
    );
    assert.ok(
      callSiteIndices(maskJsNonCode(sources.rotation), 'safeCreateExclusiveText').length >= 1,
      'archive publication must call create-exclusive safeCreateExclusiveText in real code',
    );
    assert.ok(
      sources.rotation.includes('export async function rotateAuditIntegrityGeneration'),
      'rotation module must export explicit rotateAuditIntegrityGeneration',
    );
    assert.ok(
      sources.rotation.includes('export async function recoverAuditIntegrityRotation'),
      'rotation module must export explicit recoverAuditIntegrityRotation',
    );

    // Agent CLI: the rotation feature is reachable ONLY via the two explicit
    // local commands; their handler/parser segments carry no automatic trigger.
    const segments = rotationAgentSegments(sources.agent);
    assert.doesNotMatch(
      segments.joined,
      AUTOMATIC_TRIGGER_RE,
      'rotation CLI handler/parser segments must not contain automatic triggers',
    );
    assert.ok(
      sources.agent.includes(
        "const AUDIT_INTEGRITY_ROTATE_COMMAND = 'audit-integrity-rotate';",
      ),
      'positive explicit CLI command audit-integrity-rotate is allowed',
    );
    assert.ok(
      sources.agent.includes(
        "const AUDIT_INTEGRITY_ROTATION_RECOVER_COMMAND = 'audit-integrity-rotation-recover';",
      ),
      'positive explicit recovery command audit-integrity-rotation-recover is allowed',
    );
    assert.ok(
      sources.agent.includes("} from './audit-integrity-rotation.js';"),
      'agent must import the rotation coordinator explicitly',
    );
    assert.equal(
      sources.agent.split('rotateAuditIntegrityGeneration(').length - 1,
      1,
      'rotateAuditIntegrityGeneration must have exactly one call site (manual CLI dispatch)',
    );
    assert.equal(
      sources.agent.split('recoverAuditIntegrityRotation(').length - 1,
      1,
      'recoverAuditIntegrityRotation must have exactly one call site (manual CLI dispatch)',
    );
    assert.ok(
      segments.rotateCase.includes('rotateAuditIntegrityGeneration(parsed.dataDir'),
      'the only rotate call site must be inside the explicit audit-integrity-rotate case',
    );
    assert.ok(
      segments.recoverCase.includes('recoverAuditIntegrityRotation(parsed.dataDir'),
      'the only recover call site must be inside the explicit audit-integrity-rotation-recover case',
    );

    // No HTTP route and no Web button/path for rotation anywhere.
    assert.doesNotMatch(
      sources.server,
      /rotat/i,
      'server must not expose any rotation route or vocabulary',
    );
    assert.doesNotMatch(
      sources.webApp,
      /rotat/i,
      'Web app must not expose any rotation button/path or vocabulary',
    );
    assert.doesNotMatch(
      sources.webIndex,
      /rotat/i,
      'Web index must not expose any rotation button/panel or vocabulary',
    );
  });

  it('Q2 enforces import direction and append-gate ordering', async () => {
    const sources = await readAllowedSources();

    // rotation-state imports: lexical static-import extraction (comment /
    // string / regex / template noise can neither blind nor forge an import);
    // no coordinator / journal / audit-log / agent / monitor.
    const stateImports = collectStaticImportSpecifiers(sources.rotationState);
    assert.ok(stateImports.length > 0, 'rotation-state import scan must not be vacuous');
    for (const spec of stateImports) {
      assert.doesNotMatch(
        spec,
        /audit-integrity-rotation\.js$/,
        'rotation-state must not import the rotation coordinator',
      );
      assert.doesNotMatch(
        spec,
        /audit-integrity-dual-write(?:-state)?\.js$/,
        'rotation-state must not import the dual-write coordinator/state',
      );
      assert.doesNotMatch(
        spec,
        /audit-integrity-journal\.js$/,
        'rotation-state must not import journal formulas',
      );
      assert.doesNotMatch(
        spec,
        /audit-log\.js$|agent\.js$|audit-integrity-monitor\.js$/,
        'rotation-state must not import audit-log / agent / monitor',
      );
    }
    // Positive controls: expected low-level imports are present.
    assert.ok(stateImports.includes('./error-codes.js'));
    assert.ok(stateImports.includes('./audit-integrity-write-queue.js'));
    assert.ok(stateImports.includes('./audit-event-schema.js'));

    // Import-graph closure: rotation-state retains its exact lower-level
    // closed set; a new unlisted helper cannot smuggle scheduling/deletion/
    // overwrite behavior through an innocent-looking import.
    assert.deepStrictEqual(
      stateImports,
      [...EXPECTED_ROTATION_STATE_IMPORTS],
      'rotation-state must keep its exact lower-level closed-set static import specifiers',
    );

    // The rotation coordinator legitimately imports dual-write / journal /
    // cross-store / state helpers — exactly these current imports, no more.
    const rotationImports = collectStaticImportSpecifiers(sources.rotation);
    assert.deepStrictEqual(
      rotationImports,
      [...EXPECTED_ROTATION_IMPORTS],
      'rotation coordinator must keep its exact closed-set static import specifiers (no unlisted helper)',
    );

    // Hostile canaries: the extractor must not be blinded by regex `//`,
    // comments, strings, template text, multiline or double-quoted imports,
    // and must never count dynamic import() as a static import.
    assert.deepStrictEqual(
      collectStaticImportSpecifiers('const r=/a\\/\\/b/;\nimport { readFile } from \'node:fs\';'),
      ['node:fs'],
      'extractor must survive a regex-literal // before a real import',
    );
    assert.deepStrictEqual(
      collectStaticImportSpecifiers("import {\n  createHash,\n} from \"node:crypto\";\nimport './side.js';"),
      ['node:crypto', './side.js'],
      'extractor must handle multiline and double-quoted imports',
    );
    assert.deepStrictEqual(
      collectStaticImportSpecifiers("const x = import('node:fs');"),
      [],
      'dynamic import() must not count as a static import',
    );
    assert.deepStrictEqual(
      collectStaticImportSpecifiers("const s = \"import './audit-log.js'\";\n// import './fake.js'\nimport './real.js';"),
      ['./real.js'],
      'string and line-comment imports must not count',
    );
    assert.deepStrictEqual(
      collectStaticImportSpecifiers("/*\nimport './fake-block.js'\n*/\nimport './real.js';"),
      ['./real.js'],
      'block-comment imports must not count',
    );
    assert.deepStrictEqual(
      collectStaticImportSpecifiers('const t = `\nimport \'./tpl.js\'\n`;\nimport \'./real-tpl.js\';'),
      ['./real-tpl.js'],
      'template-text imports must not count',
    );

    // No dynamic import() / CommonJS require() on the rotation/state/server/
    // web surfaces relevant to Q1/Q2. Detectors run on lexically masked code;
    // canaries prove they catch real forms and ignore comments/static imports.
    assert.match(
      maskJsNonCode("const x = import('node:fs');"),
      DYNAMIC_IMPORT_RE,
      'canary: dynamic import() must be detected',
    );
    assert.match(
      maskJsNonCode("const fs = require('node:fs');"),
      REQUIRE_RE,
      'canary: CommonJS require() must be detected',
    );
    assert.doesNotMatch(
      maskJsNonCode("import { readFile } from 'node:fs';"),
      DYNAMIC_IMPORT_RE,
      'canary: static import must not be flagged as dynamic',
    );
    assert.doesNotMatch(
      maskJsNonCode("// require('node:fs')\nconst x = 1;"),
      REQUIRE_RE,
      'canary: commented-out require must not be flagged',
    );
    for (const [label, text] of [
      ['src/audit-integrity-rotation.js', sources.rotation],
      ['src/audit-integrity-rotation-state.js', sources.rotationState],
      ['src/server.js', sources.server],
      ['src/web/app.js', sources.webApp],
    ]) {
      const masked = maskJsNonCode(text);
      assert.doesNotMatch(
        masked,
        DYNAMIC_IMPORT_RE,
        `${label} must not use dynamic import()`,
      );
      assert.doesNotMatch(
        masked,
        REQUIRE_RE,
        `${label} must not use CommonJS require()`,
      );
    }
    assert.doesNotMatch(
      sources.webIndex,
      DYNAMIC_IMPORT_RE,
      'web index must not use dynamic import()',
    );
    assert.doesNotMatch(
      sources.webIndex,
      REQUIRE_RE,
      'web index must not use CommonJS require()',
    );

    // server/web must not import rotation modules or expose rotation commands.
    for (const [label, text] of [
      ['src/server.js', sources.server],
      ['src/web/app.js', sources.webApp],
    ]) {
      const imports = collectStaticImportSpecifiers(text);
      for (const spec of imports) {
        assert.doesNotMatch(
          spec,
          /rotation/i,
          `${label} must not import rotation modules`,
        );
      }
      assert.doesNotMatch(
        text,
        ROTATION_SURFACE_VOCAB_RE,
        `${label} must not expose rotation commands`,
      );
    }

    // Production append path: audit-log appendAuditEvent is the sole wiring and
    // delegates to the dual-write coordinator.
    assert.ok(
      sources.auditLog.includes(
        "import { appendAuditEventWithIntegrityDualWrite } from './audit-integrity-dual-write.js';",
      ),
      'audit-log must import the dual-write coordinator',
    );
    assert.ok(
      /export async function appendAuditEvent\(dataDir, event, options = \{\}\) \{[\s\S]*?return appendAuditEventWithIntegrityDualWrite\(/.test(
        sources.auditLog,
      ),
      'production appendAuditEvent must delegate to appendAuditEventWithIntegrityDualWrite',
    );

    // Append gate executes before dual-state interpretation in the production
    // append path — a STRUCTURAL contract extracted from the exact exported
    // append function and the exact write-queue lease callback body (brace
    // balanced on lexically masked source; comment/string decoys cannot fake
    // a call site). Each call is required exactly once, with the gate ordered
    // before idle interpretation and before the store-mutating commit. This
    // static ordering does NOT replace runtime evidence: rotation-gates
    // G2 proves every nonterminal status (CP0/CP4/CP5/CP6) blocks ordinary
    // append without auto-recovery, and G6 proves the monitor stays
    // read-only/non-recovering — both covered separately by the full suite.
    const appendBody = extractFunctionBody(sources.dualWrite, APPEND_COORDINATOR_FN);
    assert.ok(appendBody != null, 'production append function must exist');
    assert.equal(
      callSiteIndices(maskJsNonCode(appendBody), WRITE_QUEUE_ENQUEUE_FN).length,
      1,
      'append path must enqueue on the shared write queue exactly once',
    );
    const leaseCallback = extractEnqueueLeaseCallback(appendBody);
    assert.ok(
      leaseCallback != null,
      'rotation append gate must run inside the write-queue lease callback (callback extractable)',
    );
    const gateIdxs = callSiteIndices(leaseCallback.masked, ROTATION_APPEND_GATE_FN);
    const idleIdxs = callSiteIndices(leaseCallback.masked, DUAL_WRITE_IDLE_FN);
    const commitIdxs = callSiteIndices(leaseCallback.masked, DUAL_WRITE_COMMIT_FN);
    assert.equal(
      gateIdxs.length,
      1,
      'append path must call the rotation append gate exactly once, inside the lease callback',
    );
    assert.equal(
      idleIdxs.length,
      1,
      'append path must interpret dual-write idle state exactly once, inside the lease callback',
    );
    assert.equal(
      commitIdxs.length,
      1,
      'append path must commit via commitDualWriteUnlocked exactly once, inside the lease callback',
    );
    assert.ok(
      gateIdxs[0] < idleIdxs[0],
      'rotation append gate must execute before dual-state idle interpretation',
    );
    assert.ok(
      gateIdxs[0] < commitIdxs[0],
      'rotation append gate must execute before any store mutation',
    );

    // Hostile canaries: comment/string gate decoys must not satisfy the
    // helper, and a gate placed after commit must fail the ordering relation
    // (the structural check is not vacuous).
    const decoyGateSource = `
export async function appendAuditEventWithIntegrityDualWrite(dataDir, event, options = {}) {
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    // await assertAuditIntegrityRotationAllowsAppendUnlocked(resolvedRoot, lease);
    const decoy = 'await assertAuditIntegrityRotationAllowsAppendUnlocked(resolvedRoot, lease)';
    const idle = await ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
    return commitDualWriteUnlocked(resolvedRoot, lease, idle, {});
  });
}
`;
    const decoyCallback = extractEnqueueLeaseCallback(
      extractFunctionBody(decoyGateSource, APPEND_COORDINATOR_FN),
    );
    assert.ok(decoyCallback != null, 'canary lease callback must extract');
    assert.equal(
      callSiteIndices(decoyCallback.masked, ROTATION_APPEND_GATE_FN).length,
      0,
      'comment/string gate decoys must not count as real gate call sites',
    );
    const reorderedGateSource = `
export async function appendAuditEventWithIntegrityDualWrite(dataDir, event, options = {}) {
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    const idle = await ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
    const committed = commitDualWriteUnlocked(resolvedRoot, lease, idle, {});
    await assertAuditIntegrityRotationAllowsAppendUnlocked(resolvedRoot, lease);
    return committed;
  });
}
`;
    const reorderedCallback = extractEnqueueLeaseCallback(
      extractFunctionBody(reorderedGateSource, APPEND_COORDINATOR_FN),
    );
    assert.ok(reorderedCallback != null, 'reordered canary lease callback must extract');
    const reorderedGate = callSiteIndices(reorderedCallback.masked, ROTATION_APPEND_GATE_FN);
    const reorderedCommit = callSiteIndices(reorderedCallback.masked, DUAL_WRITE_COMMIT_FN);
    assert.equal(reorderedGate.length, 1, 'reordered canary gate call must be found');
    assert.equal(reorderedCommit.length, 1, 'reordered canary commit call must be found');
    assert.ok(
      reorderedGate[0] > reorderedCommit[0],
      'ordering relation must detect a gate placed after commit (not vacuous)',
    );
  });

  it('Q3 locks the six rotation error codes, registry count 94, and path-free receipt/error output', async () => {
    const sources = await readAllowedSources();

    // Exact six V1.43 rotation error registry values.
    for (const [key, value] of Object.entries(EXPECTED_ROTATION_ERROR_CODES)) {
      assert.strictEqual(
        ERROR_CODES[key],
        value,
        `ERROR_CODES.${key} must be exactly "${value}"`,
      );
    }
    // Exact total registry count 94 with unique values.
    assert.strictEqual(
      Object.keys(ERROR_CODES).length,
      EXPECTED_REGISTRY_COUNT,
      'ERROR_CODES registry must contain exactly 94 entries',
    );
    assert.strictEqual(
      new Set(Object.values(ERROR_CODES)).size,
      EXPECTED_REGISTRY_COUNT,
      'ERROR_CODES values must be unique across all 94 entries',
    );

    // Path-free typed error: message === registered code; fixed name; code only.
    const errorClass = sliceSegment(
      sources.rotationState,
      'export class AuditIntegrityRotationError extends Error {',
      '\n}\n',
    );
    assert.ok(
      errorClass.includes('super(registered)'),
      'rotation error message must be exactly the registered code (path-free)',
    );
    assert.ok(
      errorClass.includes("this.name = 'AuditIntegrityRotationError'"),
      'rotation error name must be fixed',
    );
    assert.ok(
      errorClass.includes('this.code = registered'),
      'rotation error must carry only the registered code',
    );
    assert.doesNotMatch(
      errorClass,
      /cause|stack|rawEvent|eventLineUtf8|absolutePath|dataDir|resolvedRoot|errno/i,
      'rotation error must not embed cause/stack/raw-event/absolute-path fields',
    );
    const rotationCode = codeLinesOnly(`${sources.rotation}\n${sources.rotationState}`);
    assert.doesNotMatch(
      rotationCode,
      /\.cause\b|\bcause\s*[=:]|\.stack\b|\berrno\b/i,
      'rotation modules must never set cause/stack/errno on errors',
    );

    // Public CLI receipt shape: exact frozen key order; no cause/stack/raw-event/
    // absolute-path field; the only path-ish field is the relative archive path.
    const freezeReceipt = sliceSegment(
      sources.rotation,
      'function freezeReceipt(state, wal, relationship) {',
      '\n}\n',
    );
    assert.ok(
      freezeReceipt.includes('Object.freeze({'),
      'rotation receipt must be frozen',
    );
    const receiptKeys = [
      ...freezeReceipt.matchAll(/^\s{4}(\w+)(?:,|:)/gm),
    ].map((m) => m[1]);
    assert.deepStrictEqual(
      receiptKeys,
      EXPECTED_RECEIPT_KEYS,
      'rotation receipt keys must be the exact fixed path-free contract',
    );
    for (const key of receiptKeys) {
      assert.doesNotMatch(
        key,
        /cause|stack|raw|absolute|^path|^dir|errno/i,
        `receipt key "${key}" must not be a cause/stack/raw/absolute-path field`,
      );
    }
    assert.ok(
      sources.rotationState.includes(
        'const expectedArchivePath = `audit/archive/${previousGenerationId}`;',
      ),
      'receipt archiveRelativePath is a fixed relative archive path by construction',
    );

    // Read-only observation shape: exact frozen key order, path/raw free.
    const freezeObservation = sliceSegment(
      sources.rotation,
      'function freezeRotationReadOnlyObservation(fields) {',
      '\n}\n',
    );
    const observationKeys = [
      ...freezeObservation.matchAll(/^\s{4}(\w+)(?::|\s*,)/gm),
    ].map((m) => m[1]);
    assert.deepStrictEqual(
      observationKeys,
      EXPECTED_OBSERVATION_KEYS,
      'rotation read-only observation keys must be the exact fixed path-free contract',
    );

    // Public CLI response shapes: single-line JSON receipt on stdout; fixed
    // refusal/failure phrases on stderr; never echo error.message/stack/cause.
    const segments = rotationAgentSegments(sources.agent);
    assert.ok(
      segments.rotateCase.includes('process.stdout.write(`${JSON.stringify(receipt)}\\n`)'),
      'audit-integrity-rotate must print the receipt as single-line JSON',
    );
    assert.ok(
      segments.recoverCase.includes('process.stdout.write(`${JSON.stringify(receipt)}\\n`)'),
      'audit-integrity-rotation-recover must print the receipt as single-line JSON',
    );
    assert.ok(
      segments.rotateCase.includes('console.error(`Error: ${AUDIT_INTEGRITY_ROTATE_REFUSED_ERROR}`)'),
      'rotate refusal must use the fixed desensitized stderr phrase',
    );
    assert.ok(
      segments.recoverCase.includes('console.error(`Error: ${AUDIT_INTEGRITY_ROTATION_RECOVER_REFUSED_ERROR}`)'),
      'recover refusal must use the fixed desensitized stderr phrase',
    );
    for (const fixed of [
      "'audit-integrity-rotate arguments are invalid'",
      "'audit-integrity-rotate refused'",
      "'audit-integrity-rotate failed'",
      "'audit-integrity-rotation-recover arguments are invalid'",
      "'audit-integrity-rotation-recover refused'",
      "'audit-integrity-rotation-recover failed'",
    ]) {
      assert.ok(
        sources.agent.includes(fixed),
        `agent must define the fixed path-free CLI phrase ${fixed}`,
      );
    }
    assert.ok(
      sources.agent.includes("code.startsWith('audit-integrity-')"),
      'CLI refusal classification must be driven by registered audit-integrity codes',
    );
    assert.doesNotMatch(
      segments.joined,
      /\.message|\.stack|\bcause\b|\berrno\b/i,
      'rotation CLI handlers must never echo error message/stack/cause/errno',
    );
  });

  it('Q4 locks the V1.44 real NAS acceptance PASS surface and V1.43 historical rotation boundaries', async () => {
    assert.strictEqual(
      LINKE_RELEASE_VERSION,
      'V1.44',
      'LINKE_RELEASE_VERSION must be exactly V1.44',
    );

    const sources = await readAllowedSources();
    const { currentSurface, lines } = extractReadmeCurrentSurface(sources.readme);

    // Exact V1.44 real NAS acceptance PASS signature + fixed current-state phrases on current surface.
    assert.ok(
      currentSurface.includes(V144_SIGNATURE),
      `README current surface must include exact signature: ${V144_SIGNATURE}`,
    );
    assert.ok(
      currentSurface.includes('exact V1.44 hardware evidence PASS'),
      'current surface must state exact V1.44 hardware evidence PASS',
    );
    assert.ok(
      currentSurface.includes('real-nas-remote-backup ready'),
      'current surface must state real-nas-remote-backup ready',
    );
    assert.ok(
      currentSurface.includes('not Gold'),
      'current surface must exact-include not Gold',
    );
    assert.ok(
      currentSurface.includes('Gold remains partial 5/4/0/9'),
      'current surface must state Gold remains partial 5/4/0/9',
    );
    assert.ok(
      currentSurface.includes('four partial items remain'),
      'current surface must state four partial items remain',
    );

    // V1.43 demoted to historical row with rotation foundation facts.
    const v143Row = lines.find(
      (line) => line.includes('| V1.43 |') && line.includes('历史版本'),
    );
    assert.ok(v143Row, 'README version table must contain V1.43 historical row');
    assert.ok(
      v143Row.includes(V143_SIGNATURE),
      'V1.43 historical row must carry the exact V1.43 signature',
    );
    assert.ok(
      /explicit (manual )?rotation delivered/i.test(v143Row),
      'V1.43 historical row must state explicit (manual) rotation delivered',
    );
    assert.ok(
      /no automatic rotation|not automatic rotation/i.test(v143Row),
      'V1.43 historical row must deny automatic rotation directly',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(v143Row, 'automatic rotation'),
      'V1.43 historical row: automatic rotation must be direct clause-local negated',
    );
    assert.ok(
      /append-only/i.test(v143Row),
      'V1.43 historical row must state archive append-only policy',
    );
    assert.ok(
      /not WORM|no WORM/i.test(v143Row),
      'V1.43 historical row must deny WORM directly',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(v143Row, 'worm'),
      'V1.43 historical row: worm must be direct clause-local negated',
    );
    assert.ok(
      /not authenticity|no authenticity|no external authenticity/i.test(v143Row),
      'V1.43 historical row must deny authenticity',
    );
    assert.ok(
      v143Row.includes('not production-hardening ready'),
      'V1.43 historical row must include not production-hardening ready',
    );
    assert.ok(
      v143Row.includes('Gold remains blocked 4/4/1/9'),
      'V1.43 historical row must include Gold remains blocked 4/4/1/9',
    );
    assert.ok(
      v143Row.includes('G0c real-LAN evidence absent'),
      'V1.43 historical row must include G0c real-LAN evidence absent',
    );

    // V1.42 retained as historical row with its exact signature.
    const v142Row = lines.find(
      (line) => line.includes('| V1.42 |') && line.includes('历史版本'),
    );
    assert.ok(v142Row, 'README version table must retain V1.42 as 历史版本');
    assert.ok(
      v142Row.includes(V142_SIGNATURE),
      'V1.42 historical row must retain the exact V1.42 G0c signature',
    );

    // Retained honesty facts still on current surface (badge historical base + current row).
    assert.ok(
      currentSurface.includes('G0c real-LAN evidence absent'),
      'current surface must state G0c real-LAN evidence absent',
    );
    assert.ok(
      /not managed scheduler|no managed scheduler/i.test(currentSurface),
      'current surface must deny managed scheduler directly',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'managed scheduler'),
      'current surface: managed scheduler must be direct clause-local negated',
    );
    assert.ok(
      /not remote notification delivery|no remote notification delivery/i.test(currentSurface),
      'current surface must deny remote notification delivery directly',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'remote notification delivery'),
      'current surface: remote notification delivery must be direct clause-local negated',
    );

    // Stale current phrase and any Gold/GA/production-hardening readiness claim.
    assert.ok(
      !currentSurface.includes('no journal rotation yet'),
      'current surface must not keep stale "no journal rotation yet" wording',
    );
    assert.ok(
      currentSurface.includes('not production-hardening ready'),
      'current surface must exact-include not production-hardening ready',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'gold ready'),
      'current surface must not claim Gold ready',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'ga ready'),
      'current surface must not claim GA ready',
    );
    assert.ok(
      barePositiveIsNegatedInSameClause(currentSurface, 'production-hardening ready'),
      'current surface must not claim production-hardening ready',
    );

    // Gold-readiness surface: version V1.44; item snapshot and V1.43 evidence foundation unchanged.
    const report = buildGoldReadinessReport({ now: new Date('2026-07-25T00:00:00.000Z') });
    assert.strictEqual(report.version, 'V1.44', 'gold-readiness report version must be V1.44');
    assert.deepStrictEqual(
      report.summary,
      { ready: 5, partial: 4, blocked: 0, total: 9 },
      'Gold item snapshot counts must be 5/4/0/9',
    );
    const hardening = report.items.find((item) => item.id === 'production-hardening');
    assert.ok(hardening, 'production-hardening item must exist');
    assert.strictEqual(hardening.status, 'partial', 'production-hardening must remain partial');
    assert.ok(
      hardening.nextStep.includes(V143_SIGNATURE),
      'production-hardening nextStep must include the exact V1.43 signature',
    );
    assert.ok(
      /no automatic rotation|not automatic rotation/i.test(hardening.nextStep),
      'production-hardening nextStep must deny automatic rotation',
    );
    assert.ok(
      /not WORM|no WORM/i.test(hardening.nextStep),
      'production-hardening nextStep must deny WORM directly',
    );
    assert.ok(
      hardening.nextStep.includes('Gold remains blocked 4/4/1/9'),
      'production-hardening nextStep must retain Gold remains blocked 4/4/1/9',
    );
    assert.ok(
      !hardening.nextStep.includes('no journal rotation yet'),
      'production-hardening nextStep must not keep stale "no journal rotation yet" wording',
    );
  });
});
