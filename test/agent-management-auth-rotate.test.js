/**
 * V1.46 management-auth-rotate Agent CLI bootstrap 接线 smoke：
 * - 真实 `node src/agent.js` 子进程可识别该命令：exit 1、stdout 为空、
 *   stderr 精确为固定错误，且无 MODULE_NOT_FOUND/stack/path/token；
 * - 最窄源码接线断言：真实 import 与 switch case 存在。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');

/** 固定 stderr：顶层既有 catch 输出的唯一公开形状。 */
const FIXED_STDERR = 'Error: management-auth-rotate-failed\n';

/** 去掉颜色相关环境变量，保证输出可精确断言。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

/** 运行真实 agent 子进程，返回 { code, stdout, stderr }。 */
async function runAgent(argv) {
  try {
    const result = await execFileAsync('node', [AGENT_SRC, ...argv], {
      env: cleanEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (typeof error.code === 'number') {
      return {
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      };
    }
    throw error;
  }
}

/** 断言一次运行的公开形状：exit1 / stdout 空 / stderr 精确固定且无泄漏。 */
function assertFixedFailure(result) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '', 'stdout 必须为空');
  assert.equal(result.stderr, FIXED_STDERR, 'stderr 必须精确为固定错误');
  assert.ok(!result.stderr.includes('MODULE_NOT_FOUND'), '不得出现模块缺失');
  assert.ok(!result.stderr.includes('\n    at '), '不得出现 stack');
  assert.ok(!result.stderr.includes(REPO_ROOT), '不得回显路径');
  assert.ok(!result.stderr.includes('token'), '不得回显 token');
}

describe('agent management-auth-rotate bootstrap 接线', () => {
  it('真实子进程识别该命令并固定失败（裸命令）', async () => {
    const result = await runAgent(['management-auth-rotate']);
    assertFixedFailure(result);
  });

  it('真实子进程识别该命令并固定失败（完整未来 6-token surface）', async () => {
    // 未来固定 surface：--data-dir <path> --scope read --token-stdin；
    // skeleton 零 I/O：不得创建该路径，行为必须仍为固定失败。
    const result = await runAgent([
      'management-auth-rotate',
      '--data-dir',
      '/tmp/linke-bootstrap-placeholder',
      '--scope',
      'read',
      '--token-stdin',
    ]);
    assertFixedFailure(result);
  });

  it('最窄源码接线断言：真实 import 与 switch case', async () => {
    const source = await readFile(AGENT_SRC, 'utf8');
    assert.ok(
      source.includes(
        "import { runManagementAuthRotateCommand } from './management-auth-rotate-command.js';",
      ),
      'agent.js 必须真实 import runManagementAuthRotateCommand',
    );
    assert.ok(
      source.includes("case 'management-auth-rotate':"),
      'agent.js switch 必须包含 management-auth-rotate case',
    );
    assert.ok(
      source.includes('await runManagementAuthRotateCommand(rawArgv)'),
      'case 必须以 rawArgv 调用命令入口',
    );
  });
});
