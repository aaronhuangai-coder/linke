import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createServer } from '../src/server.js';
import { runBackupPreflightDryRun } from '../src/backup-preflight.js';

const exec = promisify(execFile);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

async function listRelativeFiles(dir, base = dir) {
  const result = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listRelativeFiles(full, base));
    } else {
      result.push(full.slice(base.length + 1));
    }
  }
  return result.sort();
}

async function createSourceFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'linke-preflight-'));
  const sourceDir = join(dataDir, 'source');
  await mkdir(join(sourceDir, 'docs'), { recursive: true });
  await mkdir(join(sourceDir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(sourceDir, 'docs', 'keep.txt'), 'keep');
  await writeFile(join(sourceDir, 'docs', 'skip.tmp'), 'skip');
  await writeFile(join(sourceDir, 'node_modules', 'pkg', 'lib.js'), 'module');
  return { dataDir, sourceDir };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

// ── Pure scanner ───────────────────────────────────────────────────

describe('runBackupPreflightDryRun — pure scanner', () => {
  it('returns included and excluded relative paths with matching patterns', async () => {
    const fixture = await createSourceFixture();
    try {
      const plan = await runBackupPreflightDryRun(fixture.sourceDir, ['*.tmp', 'node_modules']);

      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.sourcePath, fixture.sourceDir);
      assert.deepStrictEqual(plan.excludePatterns, ['*.tmp', 'node_modules']);
      assert.deepStrictEqual(plan.included, ['docs/keep.txt']);
      assert.deepStrictEqual(plan.excluded, [
        { sourceRelativePath: 'docs/skip.tmp', matchedPattern: '*.tmp' },
        { sourceRelativePath: 'node_modules/pkg/lib.js', matchedPattern: 'node_modules' },
      ]);
      assert.deepStrictEqual(plan.summary, {
        totalFiles: 3,
        includedCount: 1,
        excludedCount: 2,
      });
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('supports a single file source path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-preflight-file-'));
    try {
      const sourceFile = join(dataDir, 'one.txt');
      await writeFile(sourceFile, 'one');

      const plan = await runBackupPreflightDryRun(sourceFile, []);

      assert.deepStrictEqual(plan.included, ['one.txt']);
      assert.deepStrictEqual(plan.excluded, []);
      assert.strictEqual(plan.summary.totalFiles, 1);
      assert.strictEqual(plan.summary.includedCount, 1);
      assert.strictEqual(plan.summary.excludedCount, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ── API ────────────────────────────────────────────────────────────

describe('backup-preflight-dry-run API', () => {
  it('returns a dry-run plan and does not create snapshots or metadata', async () => {
    const fixture = await createSourceFixture();
    const dataRepoDir = join(fixture.dataDir, 'repo');
    const server = createServer({ dataDir: fixture.dataDir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const repoFilesBefore = await listRelativeFiles(dataRepoDir);
      const keepHashBefore = await fileSha256(join(fixture.sourceDir, 'docs', 'keep.txt'));
      const res = await fetch(
        `http://127.0.0.1:${port}/api/backup-preflight-dry-run?sourcePath=${encodeURIComponent(fixture.sourceDir)}&exclude=${encodeURIComponent('*.tmp')}&exclude=node_modules`,
      );

      assert.strictEqual(res.status, 200);
      const plan = await res.json();
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.summary.totalFiles, 3);
      assert.strictEqual(plan.summary.includedCount, 1);
      assert.strictEqual(plan.summary.excludedCount, 2);
      assert.deepStrictEqual(plan.included, ['docs/keep.txt']);

      assert.deepStrictEqual(await listRelativeFiles(dataRepoDir), repoFilesBefore, 'repo files must stay unchanged');
      assert.strictEqual(await pathExists(join(fixture.dataDir, 'repo', 'devices')), false, 'no devices/snapshots directory should be created');
      assert.strictEqual(await fileSha256(join(fixture.sourceDir, 'docs', 'keep.txt')), keepHashBefore, 'source files must stay unchanged');
    } finally {
      await closeServer(server);
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when sourcePath is missing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-preflight-api-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/backup-preflight-dry-run`);
      assert.strictEqual(res.status, 400);
    } finally {
      await closeServer(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when sourcePath does not exist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-preflight-api-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const missing = join(dataDir, 'missing');
      const res = await fetch(
        `http://127.0.0.1:${port}/api/backup-preflight-dry-run?sourcePath=${encodeURIComponent(missing)}`,
      );
      assert.strictEqual(res.status, 400);
    } finally {
      await closeServer(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ── CLI ────────────────────────────────────────────────────────────

describe('backup-preflight-dry-run CLI', () => {
  it('CLI outputs valid JSON with repeated --exclude flags', async () => {
    const fixture = await createSourceFixture();
    const server = createServer({ dataDir: fixture.dataDir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
      const { stdout } = await exec('node', [
        agentPath,
        'backup-preflight-dry-run',
        '--server',
        `http://127.0.0.1:${port}`,
        '--source',
        fixture.sourceDir,
        '--exclude',
        '*.tmp',
        '--exclude',
        'node_modules',
      ]);

      const plan = JSON.parse(stdout);
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldWrite, false);
      assert.deepStrictEqual(plan.included, ['docs/keep.txt']);
      assert.strictEqual(plan.summary.excludedCount, 2);
    } finally {
      await closeServer(server);
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('CLI errors when --source is missing', async () => {
    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [agentPath, 'backup-preflight-dry-run']),
      (err) => {
        assert.notStrictEqual(err.code, 0);
        assert.match(err.stderr, /source/i);
        return true;
      },
    );
  });
});
