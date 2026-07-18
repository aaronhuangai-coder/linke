import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS } from '../src/supervisor-lifecycle-actions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SINK_SRC = join(ROOT, 'src/capability-audit-sink.js');
const LIFECYCLE_SRC = join(ROOT, 'src/supervisor-lifecycle.js');
const ACTIONS_SRC = join(ROOT, 'src/supervisor-lifecycle-actions.js');

const FIXED_HEX_A = 'a'.repeat(64);
const FIXED_HEX_B = 'b'.repeat(64);
const FIXED_HEX_C = 'c'.repeat(64);
const FIXED_HEX_D = 'd'.repeat(64);

const CANONICAL_KEYS = Object.freeze([
  'schemaVersion',
  'eventKind',
  'eventFingerprint',
  'operation',
  'actionId',
  'attemptRefFingerprint',
  'proofMode',
]);

/**
 * Build a valid canonical event with exact fixed key order.
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function buildValidCanonicalEvent(overrides = {}) {
  const event = {
    schemaVersion: 1,
    eventKind: 'capability-real-audit-proof',
    eventFingerprint: FIXED_HEX_A,
    operation: 'install',
    actionId: 'render-launch-agent-plist',
    attemptRefFingerprint: FIXED_HEX_B,
    proofMode: 'real-proof',
  };
  for (const key of Object.keys(overrides)) {
    event[key] = overrides[key];
  }
  // Rebuild in fixed order so key order is always canonical.
  return {
    schemaVersion: event.schemaVersion,
    eventKind: event.eventKind,
    eventFingerprint: event.eventFingerprint,
    operation: event.operation,
    actionId: event.actionId,
    attemptRefFingerprint: event.attemptRefFingerprint,
    proofMode: event.proofMode,
  };
}

function canonicalLine(event) {
  return `${JSON.stringify({
    schemaVersion: event.schemaVersion,
    eventKind: event.eventKind,
    eventFingerprint: event.eventFingerprint,
    operation: event.operation,
    actionId: event.actionId,
    attemptRefFingerprint: event.attemptRefFingerprint,
    proofMode: event.proofMode,
  })}\n`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'linke-cap-audit-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertSinkInvalid(error, ...needles) {
  assert.equal(error?.name, 'CapabilityRealAuditSinkError');
  assert.equal(error?.code, 'capability-real-audit-sink-invalid');
  assert.equal(error?.writeAttempted, false);
  assert.equal(error?.message, 'capability-real-audit-sink-invalid');
  const text = [
    error?.name,
    error?.code,
    error?.message,
    error?.stack,
    String(error),
  ].filter(Boolean).join('\n');
  for (const needle of needles) {
    if (!needle || needle.length < 2) continue;
    if (String(error?.code || '').includes(needle)) continue;
    assert.ok(!text.includes(needle), `error must not leak: ${needle}`);
  }
}

function assertPersistFailed(error, ...needles) {
  assert.equal(error?.name, 'CapabilityRealAuditSinkError');
  assert.equal(error?.code, 'capability-real-audit-persist-failed');
  assert.equal(error?.writeAttempted, true);
  assert.equal(error?.message, 'capability-real-audit-persist-failed');
  const text = [
    error?.name,
    error?.code,
    error?.message,
    error?.stack,
    String(error),
  ].filter(Boolean).join('\n');
  for (const needle of needles) {
    if (!needle || needle.length < 2) continue;
    if (String(error?.code || '').includes(needle)) continue;
    assert.ok(!text.includes(needle), `error must not leak: ${needle}`);
  }
}

/** Shared suite root (plan cleanup pattern). */
let suiteRoot;

before(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'linke-cap-audit-suite-'));
});

after(async () => {
  if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
});

describe('capability-audit-sink exports', () => {
  it('exports exact constants and append API', async () => {
    const mod = await import('../src/capability-audit-sink.js');
    assert.equal(
      mod.CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      'audit/capability-proof-attempts.jsonl',
    );
    // 1.5 MiB file-size bytes: enough for 4096 full SoT lines + append 4097, tighter than 2 MiB.
    assert.equal(mod.CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES, 1_572_864);
    assert.equal(mod.CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES, 1536 * 1024);
    assert.equal(mod.CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES, 4096);
    assert.equal(typeof mod.appendCapabilityRealAuditProofEvent, 'function');
    assert.equal(mod.CAPABILITY_REAL_AUDIT_SINK_INVALID, 'capability-real-audit-sink-invalid');
    assert.equal(mod.CAPABILITY_REAL_AUDIT_PERSIST_FAILED, 'capability-real-audit-persist-failed');
    assert.equal(typeof mod.CapabilityRealAuditSinkError, 'function');
  });

  it('SoT canonical line UTF-8 upper bound fits 4097 lines under 1.5 MiB pre-read', async () => {
    const { CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES } = await import(
      '../src/capability-audit-sink.js'
    );
    let maxBytes = 0;
    for (const [operation, actionIds] of Object.entries(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS)) {
      for (const actionId of actionIds) {
        const line = canonicalLine(buildValidCanonicalEvent({ operation, actionId }));
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > maxBytes) maxBytes = bytes;
      }
    }
    // Lock current SoT max; fails if future SoT IDs grow past the pre-read budget.
    assert.equal(maxBytes, 328);
    assert.ok(
      maxBytes * 4097 < CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES,
      `maxBytes*4097 (${maxBytes * 4097}) must be < ${CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES}`,
    );
  });
});

describe('capability-audit-sink happy paths', () => {
  it('1. missing file → creates parent audit/ and appends one event', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      const event = buildValidCanonicalEvent();
      await appendCapabilityRealAuditProofEvent(root, event);
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const raw = await readFile(filePath, 'utf8');
      assert.equal(raw, canonicalLine(event));
      assert.equal(raw.endsWith('\n'), true);
      assert.equal(raw.split('\n').filter(Boolean).length, 1);
      assert.equal(await pathExists(join(root, 'audit')), true);
    });
  });

  it('2. empty file (raw.length === 0) → append ok', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      await writeFile(filePath, '');
      const event = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C });
      await appendCapabilityRealAuditProofEvent(root, event);
      assert.equal(await readFile(filePath, 'utf8'), canonicalLine(event));
    });
  });

  it("3. one valid line + newline → second append ok (sequential duplicate ok)", async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      const first = buildValidCanonicalEvent();
      const second = buildValidCanonicalEvent(); // same fingerprints — sequential dup allowed
      await appendCapabilityRealAuditProofEvent(root, first);
      await appendCapabilityRealAuditProofEvent(root, second);
      const raw = await readFile(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH), 'utf8');
      assert.equal(raw, `${canonicalLine(first)}${canonicalLine(second)}`);
      assert.equal(raw.split('\n').filter(Boolean).length, 2);
    });
  });

  it("6. only trailing newline ('\\n') → body '' → lines [] → allow", async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      await writeFile(filePath, '\n');
      const event = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_D });
      await appendCapabilityRealAuditProofEvent(root, event);
      assert.equal(await readFile(filePath, 'utf8'), `\n${canonicalLine(event)}`);
    });
  });
});

describe('capability-audit-sink existing JSONL preflight rejects', () => {
  it('4. missing final newline → reject; file unchanged', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const bad = canonicalLine(buildValidCanonicalEvent()).slice(0, -1); // drop trailing \n
      await writeFile(filePath, bad);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root, filePath, bad.slice(0, 40));
          return true;
        },
      );
      assert.equal(await readFile(filePath, 'utf8'), bad);
    });
  });

  it('5. internal blank line → reject', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const line = canonicalLine(buildValidCanonicalEvent());
      const poisoned = `${line}\n${line}`;
      await writeFile(filePath, poisoned);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root, filePath);
          return true;
        },
      );
      assert.equal(await readFile(filePath, 'utf8'), poisoned);
    });
  });

  it('9. bad JSON line → reject', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const bad = '{not-json\n';
      await writeFile(filePath, bad);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent()),
        (error) => {
          assertSinkInvalid(error, root, '{not-json');
          return true;
        },
      );
      assert.equal(await readFile(filePath, 'utf8'), bad);
    });
  });

  it('10. wrong key set / wrong key order → reject', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);

      // Wrong key order (values otherwise valid)
      const wrongOrder = `${JSON.stringify({
        eventKind: 'capability-real-audit-proof',
        schemaVersion: 1,
        eventFingerprint: FIXED_HEX_A,
        operation: 'install',
        actionId: 'render-launch-agent-plist',
        attemptRefFingerprint: FIXED_HEX_B,
        proofMode: 'real-proof',
      })}\n`;
      await writeFile(filePath, wrongOrder);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
      assert.equal(await readFile(filePath, 'utf8'), wrongOrder);

      // Extra key
      const withExtra = `${JSON.stringify({
        schemaVersion: 1,
        eventKind: 'capability-real-audit-proof',
        eventFingerprint: FIXED_HEX_A,
        operation: 'install',
        actionId: 'render-launch-agent-plist',
        attemptRefFingerprint: FIXED_HEX_B,
        proofMode: 'real-proof',
        extra: true,
      })}\n`;
      await writeFile(filePath, withExtra);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );

      // Missing key
      const missingKey = `${JSON.stringify({
        schemaVersion: 1,
        eventKind: 'capability-real-audit-proof',
        eventFingerprint: FIXED_HEX_A,
        operation: 'install',
        actionId: 'render-launch-agent-plist',
        attemptRefFingerprint: FIXED_HEX_B,
      })}\n`;
      await writeFile(filePath, missingKey);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
    });
  });

  it('11. wrong eventKind / proofMode / schemaVersion → reject', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);

      for (const badEvent of [
        buildValidCanonicalEvent({ eventKind: 'audit-event' }),
        buildValidCanonicalEvent({ proofMode: 'dry-run' }),
        buildValidCanonicalEvent({ schemaVersion: 2 }),
        buildValidCanonicalEvent({ schemaVersion: '1' }),
      ]) {
        const line = canonicalLine(badEvent);
        await writeFile(filePath, line);
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
            eventFingerprint: FIXED_HEX_C,
          })),
          (error) => {
            assertSinkInvalid(error, root);
            return true;
          },
        );
        assert.equal(await readFile(filePath, 'utf8'), line);
      }
    });
  });

  it('12. cross-op actionId in existing line → reject (shared SoT)', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const crossOp = buildValidCanonicalEvent({
        operation: 'install',
        actionId: 'unload-launch-agent', // uninstall action
      });
      const line = canonicalLine(crossOp);
      await writeFile(filePath, line);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
      assert.equal(await readFile(filePath, 'utf8'), line);
    });
  });

  it('13. oversize content > 1.5 MiB → reject', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES,
    } = await import('../src/capability-audit-sink.js');

    assert.equal(CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES, 1_572_864);
    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      // Explicit bound + 1 byte (file-size); fail-closed without read/append of body.
      const oversize = 'x'.repeat(CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES + 1);
      await writeFile(filePath, oversize);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent()),
        (error) => {
          assertSinkInvalid(error, root, filePath);
          return true;
        },
      );
      const st = await stat(filePath);
      assert.equal(st.size, CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES + 1);
      assert.equal(st.size, 1_572_864 + 1);
    });
  });

  it('existing line with bad hash form → reject', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const badHash = buildValidCanonicalEvent({
        eventFingerprint: 'A'.repeat(64), // uppercase not allowed
      });
      const line = canonicalLine(badHash);
      await writeFile(filePath, line);
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_C,
        })),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
    });
  });
});

describe('capability-audit-sink 4096 existing-line bound (not retention)', () => {
  it('7+8. exactly 4096 valid → append 4097th; next call rejects existing 4097', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      assert.equal(CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES, 4096);

      const base = buildValidCanonicalEvent();
      let body = '';
      for (let i = 0; i < 4096; i += 1) {
        // Vary fingerprint so lines are distinct but each valid.
        const fp = i.toString(16).padStart(64, '0');
        body += canonicalLine(buildValidCanonicalEvent({ eventFingerprint: fp }));
      }
      await writeFile(filePath, body);

      const incoming = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
        attemptRefFingerprint: FIXED_HEX_D,
      });
      await appendCapabilityRealAuditProofEvent(root, incoming);

      const after = await readFile(filePath, 'utf8');
      const lines = after.endsWith('\n')
        ? after.slice(0, -1).split('\n')
        : after.split('\n');
      assert.equal(lines.length, 4097);
      assert.equal(lines[4096], canonicalLine(incoming).slice(0, -1));

      // Next preflight with existing 4097 → reject; no delete/compact/rotate
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: 'e'.repeat(64),
        })),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
      const still = await readFile(filePath, 'utf8');
      assert.equal(still, after);
      assert.equal(still.split('\n').filter(Boolean).length, 4097);
    });
  });
});

describe('capability-audit-sink file mode + isolation', () => {
  it('14. file mode 0600 after write', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      await appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent());
      const st = await lstat(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  it('18. capability file distinct; audit/events.jsonl absent or untouched', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      const eventsPath = join(root, 'audit/events.jsonl');
      assert.equal(await pathExists(eventsPath), false);
      await appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent());
      assert.equal(await pathExists(eventsPath), false);
      assert.equal(await pathExists(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH)), true);

      // Pre-seed events.jsonl and prove it is not altered
      await mkdir(join(root, 'audit'), { recursive: true });
      const marker = '{"type":"pre-existing"}\n';
      await writeFile(eventsPath, marker);
      await appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
      }));
      assert.equal(await readFile(eventsPath, 'utf8'), marker);
    });
  });
});

describe('capability-audit-sink concurrency + queue recovery', () => {
  it('15. concurrent different events same root serialize; both succeed', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      const e1 = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_A });
      const e2 = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C });
      await Promise.all([
        appendCapabilityRealAuditProofEvent(root, e1),
        appendCapabilityRealAuditProofEvent(root, e2),
      ]);
      const raw = await readFile(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      const set = new Set(lines);
      assert.equal(set.has(canonicalLine(e1).slice(0, -1)), true);
      assert.equal(set.has(canonicalLine(e2).slice(0, -1)), true);
    });
  });

  it('16. rejected queue recovers; repeated roots cleanup behavior', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      // Invalid incoming must not poison subsequent queue on same root
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, {
          schemaVersion: 1,
          eventKind: 'capability-real-audit-proof',
          eventFingerprint: FIXED_HEX_A,
          operation: 'install',
          actionId: 'unload-launch-agent',
          attemptRefFingerprint: FIXED_HEX_B,
          proofMode: 'real-proof',
        }),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
      assert.equal(await pathExists(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH)), false);

      await appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent());
      assert.equal(
        await readFile(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH), 'utf8'),
        canonicalLine(buildValidCanonicalEvent()),
      );
    });

    // Many roots settle without blocking later work on a new root
    const roots = [];
    try {
      for (let i = 0; i < 8; i += 1) {
        const r = await mkdtemp(join(tmpdir(), `linke-cap-audit-many-${i}-`));
        roots.push(r);
        await appendCapabilityRealAuditProofEvent(
          r,
          buildValidCanonicalEvent({
            eventFingerprint: i.toString(16).padStart(64, '0'),
          }),
        );
      }
      const fresh = await mkdtemp(join(tmpdir(), 'linke-cap-audit-fresh-'));
      roots.push(fresh);
      await appendCapabilityRealAuditProofEvent(fresh, buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_D,
      }));
      const {
        CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      } = await import('../src/capability-audit-sink.js');
      assert.equal(
        (await readFile(join(fresh, CAPABILITY_REAL_AUDIT_RELATIVE_PATH), 'utf8'))
          .split('\n')
          .filter(Boolean).length,
        1,
      );
    } finally {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
    }
  });
});

describe('capability-audit-sink incoming hostile matrix', () => {
  it('20. hostile/malformed incoming → sink-invalid; no create/poison; next valid ok', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      const validSeed = buildValidCanonicalEvent();
      await appendCapabilityRealAuditProofEvent(root, validSeed);
      const before = await readFile(filePath, 'utf8');

      const wrongOrder = {
        eventKind: 'capability-real-audit-proof',
        schemaVersion: 1,
        eventFingerprint: FIXED_HEX_C,
        operation: 'install',
        actionId: 'render-launch-agent-plist',
        attemptRefFingerprint: FIXED_HEX_D,
        proofMode: 'real-proof',
      };
      const missingKey = {
        schemaVersion: 1,
        eventKind: 'capability-real-audit-proof',
        eventFingerprint: FIXED_HEX_C,
        operation: 'install',
        actionId: 'render-launch-agent-plist',
        attemptRefFingerprint: FIXED_HEX_D,
      };
      const extraKey = {
        ...buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C }),
        extra: 'nope',
      };
      const badEnum = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
        eventKind: 'other',
      });
      const badProofMode = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
        proofMode: 'execute',
      });
      const badSchema = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
        schemaVersion: 0,
      });
      const badHash = buildValidCanonicalEvent({
        eventFingerprint: 'not-a-hash',
      });
      const shortHash = buildValidCanonicalEvent({
        eventFingerprint: 'ab'.repeat(16), // 32 hex
      });
      const upperHash = buildValidCanonicalEvent({
        eventFingerprint: 'AB'.repeat(32),
      });
      const crossOp = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
        operation: 'install',
        actionId: 'start-recovery-supervisor',
      });
      const withSymbol = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C });
      Object.defineProperty(withSymbol, Symbol('hidden'), {
        value: 1,
        enumerable: true,
      });
      const withGetter = {};
      for (const key of CANONICAL_KEYS) {
        const value = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C })[key];
        Object.defineProperty(withGetter, key, {
          enumerable: true,
          get() {
            return value;
          },
        });
      }
      const customProto = Object.assign(
        Object.create({ polluted: true }),
        buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C }),
      );
      const asFunction = Object.assign(
        function eventFn() {},
        buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C }),
      );
      const proxyEvent = new Proxy(
        buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C }),
        {
          get(target, prop, receiver) {
            if (prop === 'operation') return 'install';
            return Reflect.get(target, prop, receiver);
          },
          ownKeys(target) {
            return [...Reflect.ownKeys(target), 'extraFromProxy'];
          },
          getOwnPropertyDescriptor(target, prop) {
            if (prop === 'extraFromProxy') {
              return { configurable: true, enumerable: true, value: 1 };
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
        },
      );

      const hostiles = [
        wrongOrder,
        missingKey,
        extraKey,
        badEnum,
        badProofMode,
        badSchema,
        badHash,
        shortHash,
        upperHash,
        crossOp,
        withSymbol,
        withGetter,
        customProto,
        asFunction,
        proxyEvent,
        null,
        undefined,
        'string',
        42,
        [],
        Object.create(null), // null-proto without exact own data keys set properly still fails key set
      ];

      for (const hostile of hostiles) {
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, hostile),
          (error) => {
            assertSinkInvalid(error, root, filePath, 'polluted', 'hidden');
            return true;
          },
        );
        assert.equal(await readFile(filePath, 'utf8'), before, 'must not poison existing');
      }

      // Null-proto with exact keys still allowed only if plain-record policy accepts null proto.
      // Design: plain object exact own data properties — Object.create(null) with exact keys:
      const nullProtoValid = Object.create(null);
      for (const key of CANONICAL_KEYS) {
        nullProtoValid[key] = buildValidCanonicalEvent({ eventFingerprint: FIXED_HEX_C })[key];
      }
      // Either accepted (proto null allowed) or rejected — but must not poison either way.
      try {
        await appendCapabilityRealAuditProofEvent(root, nullProtoValid);
        const afterNull = await readFile(filePath, 'utf8');
        assert.equal(afterNull.startsWith(before), true);
      } catch (error) {
        assertSinkInvalid(error, root);
        assert.equal(await readFile(filePath, 'utf8'), before);
      }

      // Reset to single-line seed for clean next-valid check if null-proto was accepted
      await writeFile(filePath, before);

      // Incoming invalid on missing file must not create/poison
      await rm(filePath, { force: true });
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(root, crossOp),
        (error) => {
          assertSinkInvalid(error, root);
          return true;
        },
      );
      // File must not be created with a poisoned line (missing still ok; empty parent ok)
      if (await pathExists(filePath)) {
        const raw = await readFile(filePath, 'utf8');
        assert.equal(raw, '');
      }

      // Next valid succeeds
      const next = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_D,
        attemptRefFingerprint: FIXED_HEX_A,
      });
      await appendCapabilityRealAuditProofEvent(root, next);
      const finalRaw = await readFile(filePath, 'utf8');
      assert.equal(finalRaw.endsWith(canonicalLine(next)), true);
    });
  });
});

describe('capability-audit-sink path/root fail-closed', () => {
  it('path/root/final-file/parent symlink fail-closed when safely testable', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
    } = await import('../src/capability-audit-sink.js');

    // Invalid root (missing)
    await assert.rejects(
      () => appendCapabilityRealAuditProofEvent(
        join(tmpdir(), 'linke-cap-audit-missing-root-nope'),
        buildValidCanonicalEvent(),
      ),
      (error) => {
        assertSinkInvalid(error);
        return true;
      },
    );

    await withTempRoot(async (root) => {
      // Root is a file, not directory
      const notDir = join(root, 'not-a-dir');
      await writeFile(notDir, 'x');
      await assert.rejects(
        () => appendCapabilityRealAuditProofEvent(notDir, buildValidCanonicalEvent()),
        (error) => {
          assertSinkInvalid(error, notDir);
          return true;
        },
      );

      // Parent audit/ is a directory symlink
      const outside = await mkdtemp(join(tmpdir(), 'linke-cap-audit-out-'));
      try {
        await symlink(outside, join(root, 'audit'), 'dir');
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent()),
          (error) => {
            assertSinkInvalid(error, root, outside);
            return true;
          },
        );
        // Outside not mutated with capability line
        const outsideEntries = await readFile(join(outside, 'capability-proof-attempts.jsonl'), 'utf8').catch(() => null);
        assert.equal(outsideEntries, null);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    await withTempRoot(async (root) => {
      // Final file symlink
      const outside = await mkdtemp(join(tmpdir(), 'linke-cap-audit-file-out-'));
      try {
        await mkdir(join(root, 'audit'));
        const outsideFile = join(outside, 'capability-proof-attempts.jsonl');
        await writeFile(outsideFile, 'OUTSIDE-SECRET\n');
        await symlink(outsideFile, join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH), 'file');
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent()),
          (error) => {
            assertSinkInvalid(error, root, outside, 'OUTSIDE-SECRET');
            return true;
          },
        );
        assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE-SECRET\n');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

describe('capability-audit-sink error stage contract', () => {
  it('pre-append fail → sink-invalid + writeAttempted:false; post-mutate → persist-failed + writeAttempted:true', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      CAPABILITY_REAL_AUDIT_SINK_INVALID,
      CAPABILITY_REAL_AUDIT_PERSIST_FAILED,
      CapabilityRealAuditSinkError,
    } = await import('../src/capability-audit-sink.js');

    assert.equal(CAPABILITY_REAL_AUDIT_SINK_INVALID, 'capability-real-audit-sink-invalid');
    assert.equal(CAPABILITY_REAL_AUDIT_PERSIST_FAILED, 'capability-real-audit-persist-failed');

    await withTempRoot(async (root) => {
      // Pre-append: invalid incoming
      try {
        await appendCapabilityRealAuditProofEvent(root, { not: 'valid' });
        assert.fail('expected throw');
      } catch (error) {
        assert.ok(error instanceof CapabilityRealAuditSinkError);
        assertSinkInvalid(error, root, '/var', '/private', 'ENOENT', 'EACCES');
      }

      // Successful write first so read path is valid
      await appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent());
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);

      // Force append open failure after preflight (read ok, incoming ok) via chmod
      await chmod(filePath, 0o444);
      await chmod(join(root, 'audit'), 0o555);
      try {
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
            eventFingerprint: FIXED_HEX_C,
          })),
          (error) => {
            assert.ok(error instanceof CapabilityRealAuditSinkError);
            assertPersistFailed(error, root, filePath, 'EACCES', 'permission');
            return true;
          },
        );
      } finally {
        await chmod(join(root, 'audit'), 0o700).catch(() => {});
        await chmod(filePath, 0o600).catch(() => {});
      }
    });
  });
});

describe('capability-audit-sink source architecture scans', () => {
  it('17+19+21. no appendAuditEvent/audit-log/lifecycle/legacy API; sole queue in sink', () => {
    const sinkSrc = readFileSync(SINK_SRC, 'utf8');
    const lifecycleSrc = readFileSync(LIFECYCLE_SRC, 'utf8');
    const actionsSrc = readFileSync(ACTIONS_SRC, 'utf8');

    // Sink must not import/call audit-log or lifecycle
    assert.equal(sinkSrc.includes('appendAuditEvent'), false);
    assert.equal(sinkSrc.includes('audit-log'), false);
    assert.equal(sinkSrc.includes('audit/events.jsonl'), false);
    assert.equal(sinkSrc.includes('supervisor-lifecycle.js'), false);
    assert.equal(/from\s+['"]\.\/supervisor-lifecycle['"]/.test(sinkSrc), false);
    assert.equal(/from\s+['"]\.\/audit-log/.test(sinkSrc), false);

    // No legacy append…Line(dataDir,…) API surface
    assert.equal(/append\w*Line\s*\(\s*dataDir/.test(sinkSrc), false);
    assert.equal(/export\s+async\s+function\s+append\w*Line/.test(sinkSrc), false);

    // Must use safe IO only (no direct fs write in production module)
    assert.equal(sinkSrc.includes('safeReadText'), true);
    assert.equal(sinkSrc.includes('safeAppendText'), true);
    assert.equal(sinkSrc.includes('assertSafeDataRoot'), true);
    assert.equal(sinkSrc.includes('SafeDataFileError'), true);
    assert.equal(/from\s+['"]node:fs['"]/.test(sinkSrc), false);
    assert.equal(/from\s+['"]node:fs\/promises['"]/.test(sinkSrc), false);
    assert.equal(/writeFileSync|appendFileSync|\.writeFile\(/.test(sinkSrc), false);

    // Sole queue Map in sink
    assert.equal(sinkSrc.includes('capabilityAuditSinkQueues'), true);
    const mapDecls = sinkSrc.match(/\bnew Map\s*\(/g) || [];
    assert.equal(mapDecls.length, 1, 'exactly one Map (sole queue) in sink');

    // SoT import for op/action
    assert.equal(sinkSrc.includes('isSupervisorLifecycleActionForOperation'), true);
    assert.equal(sinkSrc.includes('supervisor-lifecycle-actions.js'), true);

    // Lifecycle must not own a second queue Map for this sink path
    assert.equal(lifecycleSrc.includes('capabilityAuditSinkQueues'), false);
    assert.equal(lifecycleSrc.includes('capability-audit-sink'), false);
    assert.equal(lifecycleSrc.includes('appendCapabilityRealAuditProofEvent'), false);
    // No nested sink queue naming patterns in lifecycle
    assert.equal(lifecycleSrc.includes('capability-proof-attempts.jsonl'), false);

    // Actions SoT imports neither lifecycle nor sink (comments may name them; ban import paths)
    assert.equal(/from\s+['"][^'"]*capability-audit-sink['"]/.test(actionsSrc), false);
    assert.equal(/from\s+['"][^'"]*supervisor-lifecycle\.js['"]/.test(actionsSrc), false);
    assert.equal(/from\s+['"][^'"]*audit-log['"]/.test(actionsSrc), false);
    assert.equal(/require\s*\(\s*['"][^'"]*capability-audit-sink['"]/.test(actionsSrc), false);

    // JSDoc marks append-only / @internal
    assert.equal(sinkSrc.includes('@internal'), true);
    assert.equal(/append-only/i.test(sinkSrc), true);
  });

  it('suite root from plan before/after is under tmpdir only', async () => {
    assert.ok(suiteRoot);
    assert.equal(suiteRoot.startsWith(tmpdir()) || suiteRoot.includes('/T/'), true);
    // Smoke: can write via sink into suite root
    const { appendCapabilityRealAuditProofEvent } = await import('../src/capability-audit-sink.js');
    await appendCapabilityRealAuditProofEvent(
      suiteRoot,
      buildValidCanonicalEvent({ eventFingerprint: 'f'.repeat(64) }),
    );
  });
});
