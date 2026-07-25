/**
 * Test-only child worker for Linke V1.43 Tasks 5 and 8.
 *
 * Real independent Node process. Argv allowlist only:
 * rotate | append | rotate-crash.
 * Normal protocol: READY → wait non-business barrier leaf → RESULT → DONE.
 * Crash protocol: READY → barrier → CRASH_POINT:CPx → parent SIGKILL;
 * the expected crash path never emits RESULT or DONE.
 * Never prints data-dir, barrier path, stack, secrets, or raw state.
 * No shell child processes. Parent must spawn with shell:false + minimal env.
 */

import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Non-business barrier leaf under the temp data root (never under audit/). */
const BARRIER_LEAF = '.linke-rotation-child-go';

const GENERATION_ID_RE = /^[0-9a-f]{32}$/;
const HEAD_DIGEST_RE = /^[0-9a-f]{64}$/;

const BARRIER_DEADLINE_MS = 60_000;
const BARRIER_POLL_MS = 20;

/** Fixed strict-canonical business event; never accepted from argv. */
const FIXED_APPEND_EVENT = Object.freeze({
  id: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-07-20T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/rotation-child-append',
  outcome: 'success',
});

/** Allowlisted RESULT:ERROR codes (exact production string values). */
const ALLOWED_ERROR_CODES = Object.freeze(new Set([
  'audit-integrity-rotation-precondition-failed',
  'audit-integrity-rotation-recovery-required',
  'audit-integrity-process-lock-unavailable',
]));

/** Task 8 durable checkpoint → exact production test hook/error mapping. */
const CRASH_POINTS = Object.freeze({
  CP3: Object.freeze({
    hook: 'after-manifest',
    code: 'TEST_CRASH_AFTER_MANIFEST',
  }),
  CP4: Object.freeze({
    hook: 'after-new-journal',
    code: 'TEST_CRASH_AFTER_NEW_JOURNAL',
  }),
  CP5: Object.freeze({
    hook: 'after-events-post',
    code: 'TEST_CRASH_AFTER_EVENTS_POST',
  }),
  CP6: Object.freeze({
    hook: 'after-new-idle',
    code: 'TEST_CRASH_AFTER_NEW_IDLE',
  }),
});

/**
 * @param {string} line
 */
function writeLine(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Map known typed errors to allowlisted codes; everything else → worker-error.
 * @param {unknown} error
 * @returns {string}
 */
function mapErrorCode(error) {
  const code =
    error
    && typeof error === 'object'
    && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
      ? /** @type {{ code: string }} */ (error).code
      : '';
  if (ALLOWED_ERROR_CODES.has(code)) return code;
  return 'worker-error';
}

/**
 * Strict argv parser. Rejects wrong order, extras, duplicates, unknown flags.
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{
 *   op: 'rotate',
 *   dataDir: string,
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 * } | {
 *   op: 'append',
 *   dataDir: string,
 * } | {
 *   op: 'rotate-crash',
 *   dataDir: string,
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 *   crashPoint: 'CP3'|'CP4'|'CP5'|'CP6',
 * }}
 */
function parseArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1) {
    throw new Error('bad-argv');
  }
  const op = argv[0];
  if (op === 'rotate') {
    if (argv.length !== 7) throw new Error('bad-argv');
    if (argv[1] !== '--data-dir') throw new Error('bad-argv');
    if (argv[3] !== '--expected-generation-id') throw new Error('bad-argv');
    if (argv[5] !== '--expected-head-digest') throw new Error('bad-argv');
    const dataDir = argv[2];
    const expectedGenerationId = argv[4];
    const expectedHeadDigest = argv[6];
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
      throw new Error('bad-argv');
    }
    if (!GENERATION_ID_RE.test(expectedGenerationId)) throw new Error('bad-argv');
    if (!HEAD_DIGEST_RE.test(expectedHeadDigest)) throw new Error('bad-argv');
    // Reject accidental flag-like dataDir / extras already covered by length.
    if (dataDir.startsWith('--')) throw new Error('bad-argv');
    return {
      op: 'rotate',
      dataDir,
      expectedGenerationId,
      expectedHeadDigest,
    };
  }
  if (op === 'append') {
    if (argv.length !== 3) throw new Error('bad-argv');
    if (argv[1] !== '--data-dir') throw new Error('bad-argv');
    const dataDir = argv[2];
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
      throw new Error('bad-argv');
    }
    if (dataDir.startsWith('--')) throw new Error('bad-argv');
    return { op: 'append', dataDir };
  }
  if (op === 'rotate-crash') {
    if (argv.length !== 9) throw new Error('bad-argv');
    if (argv[1] !== '--data-dir') throw new Error('bad-argv');
    if (argv[3] !== '--expected-generation-id') throw new Error('bad-argv');
    if (argv[5] !== '--expected-head-digest') throw new Error('bad-argv');
    if (argv[7] !== '--crash-point') throw new Error('bad-argv');
    const dataDir = argv[2];
    const expectedGenerationId = argv[4];
    const expectedHeadDigest = argv[6];
    const crashPoint = argv[8];
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
      throw new Error('bad-argv');
    }
    if (dataDir.startsWith('--')) throw new Error('bad-argv');
    if (!GENERATION_ID_RE.test(expectedGenerationId)) throw new Error('bad-argv');
    if (!HEAD_DIGEST_RE.test(expectedHeadDigest)) throw new Error('bad-argv');
    if (!Object.hasOwn(CRASH_POINTS, crashPoint)) throw new Error('bad-argv');
    return {
      op: 'rotate-crash',
      dataDir,
      expectedGenerationId,
      expectedHeadDigest,
      crashPoint,
    };
  }
  throw new Error('bad-argv');
}

/**
 * Bounded wait for root-derived barrier leaf. Never prints the path.
 * @param {string} dataDir
 */
async function waitForBarrier(dataDir) {
  const barrierPath = join(dataDir, BARRIER_LEAF);
  const start = Date.now();
  while (Date.now() - start < BARRIER_DEADLINE_MS) {
    try {
      await access(barrierPath);
      return;
    } catch {
      const remaining = BARRIER_DEADLINE_MS - (Date.now() - start);
      if (remaining <= 0) break;
      await delay(Math.min(BARRIER_POLL_MS, remaining));
    }
  }
  throw new Error('barrier-timeout');
}

/**
 * @param {{
 *   op: 'rotate',
 *   dataDir: string,
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 * } | {
 *   op: 'append',
 *   dataDir: string,
 * } | {
 *   op: 'rotate-crash',
 *   dataDir: string,
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 *   crashPoint: 'CP3'|'CP4'|'CP5'|'CP6',
 * }} parsed
 */
async function runOperation(parsed) {
  if (parsed.op === 'rotate') {
    const { rotateAuditIntegrityGeneration } = await import(
      join(REPO_ROOT, 'src/audit-integrity-rotation.js')
    );
    const receipt = await rotateAuditIntegrityGeneration(parsed.dataDir, {
      expectedGenerationId: parsed.expectedGenerationId,
      expectedHeadDigest: parsed.expectedHeadDigest,
    });
    if (!receipt || receipt.state !== 'rotated') {
      throw new Error('unexpected-receipt');
    }
    writeLine('RESULT:OK:rotated');
    return;
  }

  if (parsed.op === 'rotate-crash') {
    const {
      AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK,
      rotateAuditIntegrityGeneration,
    } = await import(join(REPO_ROOT, 'src/audit-integrity-rotation.js'));
    const crash = CRASH_POINTS[parsed.crashPoint];
    try {
      await rotateAuditIntegrityGeneration(parsed.dataDir, {
        expectedGenerationId: parsed.expectedGenerationId,
        expectedHeadDigest: parsed.expectedHeadDigest,
        [AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: crash.hook,
      });
      throw new Error('unexpected-receipt');
    } catch (error) {
      const record = error && typeof error === 'object'
        ? /** @type {{ code?: unknown, message?: unknown }} */ (error)
        : null;
      if (record?.code !== crash.code && record?.message !== crash.code) throw error;
    }
    writeLine(`CRASH_POINT:${parsed.crashPoint}`);
    // Keep a real event-loop handle until the parent immediately SIGKILLs.
    await delay(BARRIER_DEADLINE_MS);
    throw new Error('crash-not-killed');
  }

  const { appendAuditEventWithIntegrityDualWrite } = await import(
    join(REPO_ROOT, 'src/audit-integrity-dual-write.js')
  );
  await appendAuditEventWithIntegrityDualWrite(parsed.dataDir, {
    ...FIXED_APPEND_EVENT,
  });
  writeLine('RESULT:OK:append');
}

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch {
    writeLine('RESULT:ERROR:worker-error');
    writeLine('DONE');
    process.exitCode = 1;
    return;
  }

  // Startup validation complete — signal readiness before barrier wait.
  writeLine('READY');

  try {
    await waitForBarrier(parsed.dataDir);
    await runOperation(parsed);
    writeLine('DONE');
    process.exitCode = 0;
  } catch (error) {
    const code = mapErrorCode(error);
    writeLine(`RESULT:ERROR:${code}`);
    writeLine('DONE');
    process.exitCode = code === 'worker-error' ? 1 : 0;
  }
}

main().catch(() => {
  writeLine('RESULT:ERROR:worker-error');
  writeLine('DONE');
  process.exitCode = 1;
});
