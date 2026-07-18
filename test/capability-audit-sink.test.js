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
import { readdirSync, readFileSync } from 'node:fs';
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

  it('transparent Proxy around valid canonical target → sink-invalid; no create/append; next plain valid ok', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      setCapabilityRealAuditSinkHooksForTest,
    } = await import('../src/capability-audit-sink.js');

    await withTempRoot(async (root) => {
      const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
      // Seed one plain valid line so we can prove no append on proxy rejection.
      const seed = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_A,
        attemptRefFingerprint: FIXED_HEX_B,
      });
      await appendCapabilityRealAuditProofEvent(root, seed);
      const before = await readFile(filePath, 'utf8');
      assert.equal(await pathExists(filePath), true);

      // Fully transparent Proxy: ownKeys/descriptors/proto all faithful to a valid target.
      const plainTarget = buildValidCanonicalEvent({
        eventFingerprint: FIXED_HEX_C,
        attemptRefFingerprint: FIXED_HEX_D,
      });
      const transparentProxy = new Proxy(plainTarget, {
        get(target, prop, receiver) {
          return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
          return Reflect.has(target, prop);
        },
        ownKeys(target) {
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        getPrototypeOf(target) {
          return Reflect.getPrototypeOf(target);
        },
      });
      // Sanity: without utilTypes.isProxy this would look like a plain valid record.
      assert.equal(typeof transparentProxy, 'object');
      assert.equal(Array.isArray(transparentProxy), false);
      assert.equal(Object.getPrototypeOf(transparentProxy), Object.prototype);
      assert.deepEqual(Reflect.ownKeys(transparentProxy), Reflect.ownKeys(plainTarget));

      let beforeAppendHits = 0;
      setCapabilityRealAuditSinkHooksForTest({
        beforeAppend: () => {
          beforeAppendHits += 1;
        },
      });
      try {
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, transparentProxy),
          (error) => {
            assertSinkInvalid(error, root, filePath);
            assert.equal(error.writeAttempted, false);
            return true;
          },
        );
        assert.equal(beforeAppendHits, 0, 'proxy reject must not enter beforeAppend/queue work');
        assert.equal(await readFile(filePath, 'utf8'), before, 'must not append on transparent Proxy');

        // Missing-file case: transparent Proxy must not create the file either.
        await rm(filePath, { force: true });
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, transparentProxy),
          (error) => {
            assertSinkInvalid(error, root);
            assert.equal(error.writeAttempted, false);
            return true;
          },
        );
        assert.equal(await pathExists(filePath), false, 'must not create file for Proxy event');

        // Subsequent plain valid succeeds — queue/hooks not polluted.
        const nextPlain = buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_D,
          attemptRefFingerprint: FIXED_HEX_A,
        });
        await appendCapabilityRealAuditProofEvent(root, nextPlain);
        const after = await readFile(filePath, 'utf8');
        assert.equal(after, canonicalLine(nextPlain));
        assert.equal(beforeAppendHits, 1, 'plain valid must still run hooks after Proxy reject');
      } finally {
        setCapabilityRealAuditSinkHooksForTest(null);
      }
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
  it('pre-append fail → sink-invalid + writeAttempted:false; post-append afterAppend throw → persist-failed + writeAttempted:true', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      CAPABILITY_REAL_AUDIT_SINK_INVALID,
      CAPABILITY_REAL_AUDIT_PERSIST_FAILED,
      CapabilityRealAuditSinkError,
      setCapabilityRealAuditSinkHooksForTest,
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

      // Deterministic post-append failure via afterAppend (primary stage contract; no chmod).
      try {
        setCapabilityRealAuditSinkHooksForTest({
          afterAppend: async () => {
            throw new Error('FIXTURE_SINK_AFTER_SECRET');
          },
        });
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
            eventFingerprint: FIXED_HEX_C,
          })),
          (error) => {
            assert.ok(error instanceof CapabilityRealAuditSinkError);
            assert.equal(error.code, CAPABILITY_REAL_AUDIT_PERSIST_FAILED);
            assert.equal(error.writeAttempted, true);
            assert.ok(!String(error.message).includes('FIXTURE_SINK_AFTER_SECRET'));
            return true;
          },
        );
        const filePath = join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH);
        const raw = await readFile(filePath, 'utf8');
        assert.equal(raw.trimEnd().split('\n').length, 1);
        assert.ok(raw.includes(FIXED_HEX_C));
      } finally {
        setCapabilityRealAuditSinkHooksForTest(null);
      }
    });
  });
});

describe('capability-audit-sink TEST ONLY hooks contract', () => {
  it('setter rejects hostile inputs and preserves previous hooks on invalid', async () => {
    const {
      setCapabilityRealAuditSinkHooksForTest,
    } = await import('../src/capability-audit-sink.js');

    const goodBefore = async () => {};
    const goodAfter = async () => {};
    try {
      setCapabilityRealAuditSinkHooksForTest({ beforeAppend: goodBefore, afterAppend: goodAfter });

      const hostiles = [
        { beforeAppend: 1 },
        { extra: async () => {} },
        'string',
        [async () => {}],
        new Proxy({ beforeAppend: goodBefore }, {}),
        Object.defineProperty({}, 'beforeAppend', { enumerable: true, get: () => goodBefore }),
        { beforeAppend: 'nope' },
        { afterAppend: 42 },
        Object.assign(Object.create({ x: 1 }), { beforeAppend: goodBefore }),
      ];
      for (const bad of hostiles) {
        assert.throws(
          () => setCapabilityRealAuditSinkHooksForTest(bad),
          (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'capability-real-audit-sink-invalid');
            return true;
          },
        );
      }
      // Old hooks retained across invalid attempts.
      setCapabilityRealAuditSinkHooksForTest(null);
      let hit = 0;
      setCapabilityRealAuditSinkHooksForTest({
        beforeAppend: async () => {
          hit += 1;
        },
      });
      assert.throws(
        () => setCapabilityRealAuditSinkHooksForTest({ beforeAppend: 1 }),
        (error) => error instanceof Error && error.message === 'capability-real-audit-sink-invalid',
      );
      // hit counter hook still installed after invalid setter throw.
      const {
        appendCapabilityRealAuditProofEvent,
      } = await import('../src/capability-audit-sink.js');
      await withTempRoot(async (root) => {
        await appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent({
          eventFingerprint: FIXED_HEX_D,
        }));
        assert.equal(hit, 1, 'invalid setter must retain previous beforeAppend hook');
      });
    } finally {
      setCapabilityRealAuditSinkHooksForTest(null);
    }
  });

  it('beforeAppend throw is pre-append sink-invalid writeAttempted:false; no line', async () => {
    const {
      appendCapabilityRealAuditProofEvent,
      CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
      CAPABILITY_REAL_AUDIT_SINK_INVALID,
      CapabilityRealAuditSinkError,
      setCapabilityRealAuditSinkHooksForTest,
    } = await import('../src/capability-audit-sink.js');

    try {
      setCapabilityRealAuditSinkHooksForTest({
        beforeAppend: async () => {
          throw new Error('FIXTURE_BEFORE_SECRET');
        },
      });
      await withTempRoot(async (root) => {
        await assert.rejects(
          () => appendCapabilityRealAuditProofEvent(root, buildValidCanonicalEvent()),
          (error) => {
            assert.ok(error instanceof CapabilityRealAuditSinkError);
            assert.equal(error.code, CAPABILITY_REAL_AUDIT_SINK_INVALID);
            assert.equal(error.writeAttempted, false);
            assert.ok(!String(error.message).includes('FIXTURE_BEFORE_SECRET'));
            return true;
          },
        );
        assert.equal(await pathExists(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH)), false);
      });
    } finally {
      setCapabilityRealAuditSinkHooksForTest(null);
    }
  });
});

describe('capability-audit-sink source architecture scans', () => {
  it('17+19+21. no appendAuditEvent/audit-log/lifecycle/legacy API; sole queue in sink', () => {
    const sinkSrc = readFileSync(SINK_SRC, 'utf8');
    const lifecycleSrc = readFileSync(LIFECYCLE_SRC, 'utf8');
    const actionsSrc = readFileSync(ACTIONS_SRC, 'utf8');
    const agentSrc = readFileSync(join(ROOT, 'src/agent.js'), 'utf8');
    const serverSrc = readFileSync(join(ROOT, 'src/server.js'), 'utf8');

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

    // Sole queue Map in sink — hooks must not introduce a second Map/queue
    assert.equal(sinkSrc.includes('capabilityAuditSinkQueues'), true);
    const mapDecls = sinkSrc.match(/\bnew Map\s*\(/g) || [];
    assert.equal(mapDecls.length, 1, 'exactly one Map (sole queue) in sink');
    assert.equal(/\bnew Set\s*\(/.test(sinkSrc), false);

    // SoT import for op/action
    assert.equal(sinkSrc.includes('isSupervisorLifecycleActionForOperation'), true);
    assert.equal(sinkSrc.includes('supervisor-lifecycle-actions.js'), true);

    // Lifecycle may import/call exact sink API for RealAuditProof, but MUST NOT own a second queue Map.
    assert.equal(lifecycleSrc.includes('capabilityAuditSinkQueues'), false);
    // V1.34 C3: lifecycle RealAuditProof calls exact sink API (sole queue remains in sink).
    assert.equal(lifecycleSrc.includes("from './capability-audit-sink.js'"), true);
    assert.equal(lifecycleSrc.includes('appendCapabilityRealAuditProofEvent'), true);
    assert.equal(
      /await\s+appendCapabilityRealAuditProofEvent\s*\(\s*resolvedDataRoot\s*,\s*canonicalEvent\s*\)/.test(
        lifecycleSrc,
      ),
      true,
    );
    // RealAuditProof region must not hardcode sink path / import audit-log / call generic HTTP audit helper.
    const auditProofSlice = lifecycleSrc.includes('// ── V1.34 Real audit capability sink persist')
      ? lifecycleSrc.slice(lifecycleSrc.indexOf('// ── V1.34 Real audit capability sink persist'))
      : '';
    assert.ok(auditProofSlice.length > 100);
    assert.equal(auditProofSlice.includes('capability-proof-attempts.jsonl'), false);
    assert.equal(auditProofSlice.includes('appendAuditEvent'), false);
    assert.equal(auditProofSlice.includes('audit/events.jsonl'), false);
    assert.equal(/from\s+['"]\.\/audit-log/.test(lifecycleSrc), false);

    // Actions SoT imports neither lifecycle nor sink (comments may name them; ban import paths)
    assert.equal(/from\s+['"][^'"]*capability-audit-sink['"]/.test(actionsSrc), false);
    assert.equal(/from\s+['"][^'"]*supervisor-lifecycle\.js['"]/.test(actionsSrc), false);
    assert.equal(/from\s+['"][^'"]*audit-log['"]/.test(actionsSrc), false);
    assert.equal(/require\s*\(\s*['"][^'"]*capability-audit-sink['"]/.test(actionsSrc), false);

    // JSDoc marks append-only / @internal
    assert.equal(sinkSrc.includes('@internal'), true);
    assert.equal(/append-only/i.test(sinkSrc), true);

    // TEST ONLY setter: defined in sink; zero production references (agent/server/lifecycle).
    assert.equal(sinkSrc.includes('export function setCapabilityRealAuditSinkHooksForTest'), true);
    assert.equal(sinkSrc.includes('@internal TEST ONLY'), true);
    assert.equal(lifecycleSrc.includes('setCapabilityRealAuditSinkHooksForTest'), false);
    assert.equal(agentSrc.includes('setCapabilityRealAuditSinkHooksForTest'), false);
    assert.equal(serverSrc.includes('setCapabilityRealAuditSinkHooksForTest'), false);
    // Production bootstrap path must not call setter (default null).
    assert.equal(/setCapabilityRealAuditSinkHooksForTest\s*\(/.test(
      sinkSrc.replace(/export function setCapabilityRealAuditSinkHooksForTest[\s\S]*?\n\}/, ''),
    ), false);
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

// ── V1.34 Task10: side-effect / sensitive / scope characterization scans ──
// Forbidden forms assembled at runtime so this file does not self-trip scanners.

const TASK10_KNOWN_JS = Object.freeze([
  'src/supervisor-lifecycle.js',
  'src/capability-audit-sink.js',
  'src/supervisor-lifecycle-actions.js',
  'src/agent.js',
  'src/server.js',
  'test/capability-audit-sink.test.js',
  'test/supervisor-lifecycle-guarded-runner-execution-gate.test.js',
  'test/supervisor-lifecycle-actions.test.js',
]);

function task10RelPath(absPath) {
  const root = ROOT.replaceAll('\\', '/');
  const full = String(absPath).replaceAll('\\', '/');
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
}

/** Recursive collect; directory read failure throws with safe relative path (never silent). */
function task10CollectFiles(dir, predicate, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = err && err.code ? ` (${err.code})` : '';
    throw new Error(`task10CollectFiles failed to read directory: ${task10RelPath(dir)}${code}`);
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.superpowers') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) task10CollectFiles(full, predicate, acc);
    else if (entry.isFile() && predicate(full, entry.name)) acc.push(full);
  }
  return acc;
}

function task10AssertKnownPresent(files, required) {
  const set = new Set(files.map(task10RelPath));
  for (const req of required) assert.ok(set.has(req), `scan must include known file: ${req}`);
}

/** append*Line symbol ban (decl/arrow/method/alias all hit). Runtime-assembled. */
function task10LegacyAppendLineSymbolPattern() {
  return new RegExp(String.raw`\b` + ['ap', 'pend'].join('') + String.raw`\w*` + ['Li', 'ne'].join('') + String.raw`\b`);
}

function task10HostileLegacySamples() {
  const s = ['ap', 'pend', 'LegacyAudit', 'Li', 'ne'].join('');
  return {
    call: `${s}(dataDir, rawLine)`,
    arrow: `const ${s} = (dataDir) => {}`,
    method: `const o = { ${s}(dataDir) {} }`,
    aliasCall: `const alias = ${s}; alias(dataDir)`,
  };
}

const TASK10_POSITIVE_CONTRACT_RES = Object.freeze([
  /schema[\s_-]+agnostic/i,
  /schema[\s_-]+indifferent/i,
  /\bsink\s+accepts\s+(?:arbitrary|opaque|unvalidated)\b/i,
  /\baccepts\s+(?:arbitrary|opaque|unvalidated)\s+events?\b/i,
  /\b(?:arbitrary|unvalidated)\s+events?\b/i,
]);

/** Clause boundaries: ;；。 English/Chinese comma, English period + whitespace/end. */
const TASK10_CLAUSE_SPLIT_RE = /[;；。,，]|\.(?=\s|$)/;

/**
 * Local negation for one positive match only (not whole-clause short-circuit).
 * Pre: negation tightly targeting accept/schema phrase.
 * Post: adjacent forbidden/rejected predicate of that phrase.
 */
function task10PositiveMatchNegated(clause, start, end) {
  const match = clause.slice(start, end);
  const before = clause.slice(0, start);
  const after = clause.slice(end);
  const preWindow = before.slice(-80);
  const postWindow = after.slice(0, 80);

  // Accept / arbitrary / unvalidated family — pre-negation on the claim.
  if (/(?:accept|arbitrary|opaque|unvalidated)/i.test(match)) {
    if (
      /(?:MUST\s+NOT|must\s+not|do(?:es)?\s+not|don'?t|doesn'?t|cannot|can\s+not|never|不得|不要|不能|禁止|拒绝|不得存在)(?:\s+[\w./-]*){0,6}\s*$/i
        .test(preWindow)
    ) {
      return true;
    }
  }

  // Schema-agnostic / schema-indifferent family — pre-negation on the claim.
  if (/schema/i.test(match)) {
    if (
      /(?:is\s+not|are\s+not|\bno\b|\bnot\b|non|不得|不要|不能|禁止|拒绝|非)(?:[\s\w./-]*){0,4}\s*$/i
        .test(preWindow)
    ) {
      return true;
    }
  }

  // Post: subject of the positive phrase is forbidden/rejected (not unrelated 不得 later).
  if (/\b(?:is|are|was|were)\s+(?:forbidden|forbid(?:den)?|banned?|rejected)\b/i.test(postWindow)) {
    return true;
  }
  if (/^\s*(?:forbidden|forbid(?:den)?|banned?|rejected)\b/i.test(postWindow)) {
    return true;
  }

  return false;
}

/**
 * Positive sink-contract hits with boundary split + per-match local negation.
 * REJECTED token or line-leading R-* rejects the whole line (not mid-clause R-*).
 */
function task10FindPositiveSinkContractHits(text) {
  const hits = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/\bREJECTED\b/.test(line)) continue;
    const trimmedLine = line.trim();
    if (/^(?:[-*•]\s*)?R-[A-Za-z][A-Za-z0-9]*\b/.test(trimmedLine)) continue;

    for (const clause of line.split(TASK10_CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean)) {
      let hit = false;
      for (const re of TASK10_POSITIVE_CONTRACT_RES) {
        const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        let m;
        while ((m = gre.exec(clause)) !== null) {
          if (task10PositiveMatchNegated(clause, m.index, m.index + m[0].length)) continue;
          hit = true;
          break;
        }
        if (hit) break;
      }
      if (hit) hits.push(clause);
    }
  }
  return hits;
}

function task10StripJsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function task10StaticSpecifiers(src) {
  const code = task10StripJsComments(src);
  const out = [];
  const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[2]);
  return out;
}

/** Basename/path exact module match at any relative depth (not lifecycle-actions as lifecycle). */
function task10SpecMatchesModule(spec, name) {
  const norm = String(spec).replaceAll('\\', '/');
  const base = (norm.split('/').pop() || '').replace(/\.js$/i, '');
  return base === name || norm === name || norm === `${name}.js`
    || norm.endsWith(`/${name}`) || norm.endsWith(`/${name}.js`);
}

function task10ForbiddenSpecs(src, names) {
  return task10StaticSpecifiers(src).flatMap((spec) => (
    names.filter((n) => task10SpecMatchesModule(spec, n)).map((n) => `${n} via ${spec}`)
  ));
}

function task10HasCall(src, symbol) {
  return new RegExp(String.raw`\b${symbol}\s*\(`).test(task10StripJsComments(src));
}

function task10HasImportBinding(src, symbol) {
  return new RegExp(String.raw`\bimport\s*\{[^}]*\b${symbol}\b`).test(task10StripJsComments(src));
}

describe('V1.34 Task10 side-effect / sensitive / scope scans (sink tree)', () => {
  it('legacy append*Line symbol absent from src/**+test/** JS; rejects call/arrow/method/alias hostiles', () => {
    const pat = task10LegacyAppendLineSymbolPattern();
    for (const [kind, sample] of Object.entries(task10HostileLegacySamples())) {
      assert.equal(pat.test(sample), true, `hostile ${kind}`);
    }
    assert.equal(pat.test('append\\w*Line'), false);

    const jsFiles = [
      ...task10CollectFiles(join(ROOT, 'src'), (_f, n) => n.endsWith('.js')),
      ...task10CollectFiles(join(ROOT, 'test'), (_f, n) => n.endsWith('.js')),
    ];
    assert.ok(jsFiles.length > 20);
    task10AssertKnownPresent(jsFiles, TASK10_KNOWN_JS);
    const offenders = jsFiles.filter((f) => pat.test(readFileSync(f, 'utf8'))).map(task10RelPath);
    assert.deepEqual(offenders, [], `append*Line symbol: ${offenders.join(', ')}`);
  });

  it('docs/**+src/** no positive sink-schema contract at clause level; pure+mixed hostiles detected', () => {
    // Runtime-assembled so continuous positive phrases are not tree-scan self-hits.
    const pure = ['sink accepts ', 'arbitrary ', 'unvalidated event ', 'with schema', '-agnostic ', 'and schema', '-indifferent validation'].join('');
    assert.ok(task10FindPositiveSinkContractHits(pure).length >= 1, 'pure hostile');

    // Boundary matrix: English period+ws, English/Chinese comma must expose positive half.
    const boundaryPositives = [
      ['do not validate', '. ', 'sink accepts ', 'arbitrary events'].join(''),
      ['do not validate', ', ', 'sink accepts ', 'arbitrary events'].join(''),
      ['不要校验', '，', 'sink accepts ', 'arbitrary events'].join(''),
      ['do not validate', '; ', 'sink accepts ', 'arbitrary events'].join(''),
    ];
    for (const sample of boundaryPositives) {
      assert.ok(
        task10FindPositiveSinkContractHits(sample).some((h) => /sink accepts\s+arbitrary events/i.test(h)),
        `boundary positive: ${sample}`,
      );
    }

    // Local negation must not whole-clause short-circuit unrelated not/不得.
    const localNotNegated = [
      ['sink accepts ', 'arbitrary events', ' and is not coupled to HTTP'].join(''),
      ['schema', '-indifferent sinks ', '不得写入 events.jsonl'].join(''),
    ];
    for (const sample of localNotNegated) {
      assert.ok(
        task10FindPositiveSinkContractHits(sample).length >= 1,
        `local non-short-circuit: ${sample}`,
      );
    }

    // Pure negatives / rejected rows must not hit.
    const pureNegatives = [
      'MUST NOT accept arbitrary events',
      'do not accept arbitrary events',
      "don't accept arbitrary events",
      "doesn't accept arbitrary events",
      'cannot accept arbitrary events',
      'sink must not accept arbitrary events',
      'sink is not schema-indifferent',
      'schema-indifferent sinks are forbidden',
      'REJECTED = second action-ID list / sink schema-indifferent / prefer-lifecycle-only validation',
      '// - no sink-schema-indifferent contract language in docs/src',
      '不得存在 sink accepts arbitrary unvalidated event',
      'MUST NOT accept arbitrary events; sink is not schema-agnostic',
      'R-SinkSchemaIndifferent is an explicit rejection row about schema-indifferent sinks',
      '- R-ArbitraryEvents: accepts arbitrary events is rejected',
      'event schema/op/action 非无关、必须校验',
    ];
    for (const line of pureNegatives) {
      assert.deepEqual(task10FindPositiveSinkContractHits(line), [], line);
    }
    assert.ok(
      task10FindPositiveSinkContractHits('note about R-SinkSchemaIndifferent; sink accepts arbitrary events').length >= 1,
      'mid-clause R-* must not whole-line-allow later positive',
    );

    const targets = [
      ...task10CollectFiles(join(ROOT, 'docs'), (_f, n) => n.endsWith('.md')),
      ...task10CollectFiles(join(ROOT, 'src'), (_f, n) => n.endsWith('.js')),
    ];
    assert.ok(targets.length > 10);
    task10AssertKnownPresent(targets, TASK10_KNOWN_JS.filter((p) => p.startsWith('src/')));
    const offenders = [];
    for (const file of targets) {
      const hits = task10FindPositiveSinkContractHits(readFileSync(file, 'utf8'));
      if (hits.length) offenders.push(`${task10RelPath(file)}: ${hits[0]}`);
    }
    assert.deepEqual(offenders, [], offenders.join(' | '));
  });

  it('import graph any relative depth (comment-stripped): lifecycle/sink/actions + cwd-stable agent/server', () => {
    const lifecycleSrc = readFileSync(LIFECYCLE_SRC, 'utf8');
    const sinkSrc = readFileSync(SINK_SRC, 'utf8');
    const actionsSrc = readFileSync(ACTIONS_SRC, 'utf8');

    assert.deepEqual(task10ForbiddenSpecs(lifecycleSrc, ['audit-log']), []);
    assert.equal(task10HasCall(lifecycleSrc, 'appendAuditEvent'), false);
    assert.equal(task10HasImportBinding(lifecycleSrc, 'appendAuditEvent'), false);

    assert.deepEqual(task10ForbiddenSpecs(sinkSrc, ['audit-log', 'supervisor-lifecycle']), []);
    assert.equal(task10HasCall(sinkSrc, 'appendAuditEvent'), false);

    assert.deepEqual(
      task10ForbiddenSpecs(actionsSrc, ['supervisor-lifecycle', 'capability-audit-sink', 'audit-log']),
      [],
    );
    assert.equal(task10HasCall(actionsSrc, 'appendAuditEvent'), false);
    assert.equal(task10HasCall(actionsSrc, 'appendCapabilityRealAuditProofEvent'), false);

    for (const [label, src] of [
      ['agent', readFileSync(join(ROOT, 'src/agent.js'), 'utf8')],
      ['server', readFileSync(join(ROOT, 'src/server.js'), 'utf8')],
    ]) {
      for (const token of [
        'RealAuditProof',
        'capability-audit-sink',
        'invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof',
        'authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof',
        'appendCapabilityRealAuditProofEvent',
        'setCapabilityRealAuditSinkHooksForTest',
      ]) {
        assert.equal(src.includes(token), false, `${label} ${token}`);
      }
    }

    const hostile = [
      "import x from '../../lib/audit-log.js'",
      "const m = require('../vendor/supervisor-lifecycle')",
      "await import('../../../capability-audit-sink.js')",
      "import './nested/audit-log'",
    ].join('\n');
    assert.ok(task10ForbiddenSpecs(hostile, ['audit-log']).length >= 2);
    assert.ok(task10ForbiddenSpecs(hostile, ['supervisor-lifecycle']).length >= 1);
    assert.ok(task10ForbiddenSpecs(hostile, ['capability-audit-sink']).length >= 1);
    assert.deepEqual(
      task10ForbiddenSpecs("import { x } from './supervisor-lifecycle-actions.js'", ['supervisor-lifecycle']),
      [],
    );
  });
});
