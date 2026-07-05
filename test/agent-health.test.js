import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

const exec = promisify(execFile);

describe('Agent health CLI', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-health-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('outputs JSON health payload without requiring a device or mutating dataDir', async () => {
    assert.deepStrictEqual(await readdir(dataDir), []);
    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    const { stdout } = await exec('node', [
      agentPath,
      'health',
      '--server',
      `http://localhost:${port}`,
    ]);

    const body = JSON.parse(stdout);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'linke');
    assert.strictEqual(body.version, 'V0.48');
    assert.strictEqual(body.checks.http, 'ok');
    assert.strictEqual(body.checks.dataDirReadable, 'ok');
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    assert.ok(!stdout.includes(dataDir));
    assert.deepStrictEqual(await readdir(dataDir), []);
  });

  it('exits non-zero when the server is unreachable', async () => {
    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath,
        'health',
        '--server',
        'http://127.0.0.1:1',
      ]),
      (err) => {
        assert.notStrictEqual(err.code, 0);
        assert.match(err.stderr, /Error:/);
        return true;
      },
    );
  });
});
