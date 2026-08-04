/**
 * V1.46 management-auth-rotate Agent CLI 正式公开边界。
 * 仅验证参数/stdin 早失败和可安全制造的锁拒绝；不跑真实 Keychain 成功路径。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const ARGUMENTS_STDERR = 'Error: management-auth-rotate arguments are invalid\n';
const STDIN_STDERR = 'Error: management-auth-rotate stdin is invalid\n';
const REFUSED_STDERR = 'Error: management-auth-rotate refused\n';
const TOKEN = `agent-rotation-token_${'T'.repeat(22)}`;

async function withTempRoot(prefix, fn) {
  const root = resolve(await mkdtemp(join(tmpdir(), `linke-agent-mar-${prefix}-`)));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runAgent(argv, { input = '', keepStdinOpen = false, timeoutMs = 10_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [AGENT_SRC, ...argv], {
      env: Object.create(null),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error('agent subprocess timeout'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
    if (!keepStdinOpen) child.stdin.end(input);
  });
}

function assertPublicResult(result, { code, stderr, forbidden = [] }) {
  assert.equal(result.code, code);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stderr);
  assert.equal(result.stderr.includes('MODULE_NOT_FOUND'), false);
  assert.equal(result.stderr.includes('\n    at '), false);
  assert.equal(result.stderr.includes(REPO_ROOT), false);
  for (const value of forbidden) {
    if (value) assert.equal(result.stderr.includes(String(value)), false);
  }
}

async function assertAbsent(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

describe('management-auth-rotate Agent argv 早失败', () => {
  it('裸命令在 stdin 保持打开时仍立即 arguments-invalid', async () => {
    const result = await runAgent(['management-auth-rotate'], { keepStdinOpen: true });
    assertPublicResult(result, { code: 1, stderr: ARGUMENTS_STDERR });
  });

  const argvBuilders = [
    (dataDir) => ['management-auth-rotate', '--data-dir', dataDir, '--scope', 'read'],
    (dataDir) => ['management-auth-rotate', '--scope', 'read', '--data-dir', dataDir, '--token-stdin'],
    (dataDir) => ['management-auth-rotate', '--data-dir', dataDir, '--scope', 'read', '--scope'],
    (dataDir) => ['management-auth-rotate', '--data-dir', dataDir, '--scope', 'read', '--token-stdin', 'extra'],
    (dataDir) => ['management-auth-rotate', '--data-dir', dataDir, '--scope', 'read', '--new-token-stdin'],
    (dataDir) => ['management-auth-rotate', '--data-dir', dataDir, '--scope', 'read', '--token', TOKEN],
    (dataDir) => [
      'management-auth-rotate', '--data-dir', dataDir, '--scope', 'read', '--token-stdin',
      '--restart-controller',
    ],
    (dataDir) => [
      'management-auth-rotate', '--data-dir', dataDir, '--scope', 'read', '--token-stdin',
      '--restart-controller', '--controller-port', '0',
    ],
  ];

  for (const [index, buildArgv] of argvBuilders.entries()) {
    it(`无效 argv 样本 ${index + 1} 固定 arguments-invalid 且不创建 dataDir`, async () => {
      await withTempRoot(`argv-${index}`, async (root) => {
        const dataDir = join(root, 'must-not-exist');
        const result = await runAgent(buildArgv(dataDir), { input: `${TOKEN}\n` });
        assertPublicResult(result, {
          code: 1,
          stderr: ARGUMENTS_STDERR,
          forbidden: [TOKEN, dataDir],
        });
        await assertAbsent(dataDir);
      });
    });
  }
});

describe('management-auth-rotate Agent stdin 早失败', () => {
  const invalidInputs = [
    '',
    '\n',
    'abc\n',
    `${TOKEN}\n${TOKEN}\n`,
    `${TOKEN}\n\n`,
    `${'A'.repeat(42)}=\n`,
    `${'A'.repeat(4096)}\n`,
  ];

  for (const [index, input] of invalidInputs.entries()) {
    it(`无效 stdin 样本 ${index + 1} 固定 stdin-invalid 且不建锁目录`, async () => {
      await withTempRoot(`stdin-${index}`, async (root) => {
        const dataDir = join(root, 'must-not-exist');
        const result = await runAgent([
          'management-auth-rotate',
          '--data-dir',
          dataDir,
          '--scope',
          'read',
          '--token-stdin',
        ], { input });
        assertPublicResult(result, {
          code: 1,
          stderr: STDIN_STDERR,
          forbidden: [TOKEN, dataDir, input.replace(/[\r\n]/g, '')],
        });
        await assertAbsent(dataDir);
      });
    });
  }
});

describe('management-auth-rotate Agent refusal 与源码接线', () => {
  it('有效 token + 不可建锁 dataDir → exit 2 refused，不触真实 Keychain 读写', async () => {
    await withTempRoot('refused', async (root) => {
      const blocker = join(root, 'blocker');
      await writeFile(blocker, 'synthetic', { mode: 0o600 });
      const dataDir = join(blocker, 'child');
      const result = await runAgent([
        'management-auth-rotate',
        '--data-dir',
        dataDir,
        '--scope',
        'read',
        '--token-stdin',
      ], { input: `${TOKEN}\n` });
      assertPublicResult(result, {
        code: 2,
        stderr: REFUSED_STDERR,
        forbidden: [TOKEN, dataDir],
      });
    });
  });

  for (const scope of ['full', 'admin']) {
    it(`scope=${scope} 通过真实 Agent argv 解析后在锁边界 refused，而非 arguments-invalid`, async () => {
      await withTempRoot(`refused-${scope}`, async (root) => {
        const blocker = join(root, 'blocker');
        await writeFile(blocker, 'synthetic', { mode: 0o600 });
        const dataDir = join(blocker, 'child');
        const result = await runAgent([
          'management-auth-rotate',
          '--data-dir',
          dataDir,
          '--scope',
          scope,
          '--token-stdin',
        ], { input: `${TOKEN}\n` });
        assertPublicResult(result, {
          code: 2,
          stderr: REFUSED_STDERR,
          forbidden: [TOKEN, dataDir],
        });
      });
    });
  }

  it('显式 restart + required audit 不可写 → exit 2 refused，早于 Keychain/launchctl', async () => {
    await withTempRoot('restart-audit-refused', async (root) => {
      const blocker = join(root, 'blocker');
      await writeFile(blocker, 'synthetic', { mode: 0o600 });
      const dataDir = join(blocker, 'child');
      const result = await runAgent([
        'management-auth-rotate',
        '--data-dir',
        dataDir,
        '--scope',
        'read',
        '--token-stdin',
        '--restart-controller',
        '--controller-port',
        '3000',
      ], { input: `${TOKEN}\n` });
      assertPublicResult(result, {
        code: 2,
        stderr: REFUSED_STDERR,
        forbidden: [TOKEN, dataDir, '/bin/launchctl'],
      });
    });
  });

  it('真实 command、两类 refusal error 与固定文案均接入 management-auth-rotate case', async () => {
    const source = await readFile(AGENT_SRC, 'utf8');
    assert.ok(source.includes("from './management-auth-rotate-command.js'"));
    assert.ok(source.includes('runManagementAuthRotateCommand'));
    assert.ok(source.includes('ManagementAuthRotateCommandError'));
    assert.ok(source.includes('ManagementAuthRotationError'));
    assert.ok(source.includes('ManagementAuthRotationProcessLockError'));
    assert.ok(source.includes('ManagementAuthControllerRestartError'));
    assert.ok(source.includes("case 'management-auth-rotate':"));
    assert.ok(source.includes('await runManagementAuthRotateCommand(rawArgv)'));
    for (const phrase of [
      'management-auth-rotate arguments are invalid',
      'management-auth-rotate stdin is invalid',
      'management-auth-rotate refused',
      'management-auth-rotate failed',
    ]) {
      assert.ok(source.includes(phrase), `missing fixed phrase ${phrase}`);
    }
  });

  it('usage 公开显式 restart-controller/controller-port，仍不公开 new-token-stdin', async () => {
    const source = await readFile(AGENT_SRC, 'utf8');
    assert.ok(source.includes('--data-dir'));
    assert.ok(source.includes('--scope'));
    assert.ok(source.includes('--token-stdin'));
    assert.ok(source.includes('--restart-controller'));
    assert.ok(source.includes('--controller-port'));
    assert.ok(source.includes('--scope <full|read|write|admin>'));
    assert.equal(source.includes('--new-token-stdin'), false);
  });
});
