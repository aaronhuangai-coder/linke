# Linke V1.44 Real SMB Inspection Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 macOS 上已挂载 SMB 被 Linke 误判为非 SMB 的问题，并确保复制、周期复检与恢复全程检查同一个 canonical mount root。

**Architecture:** `inspectMountedSmb()` 使用固定 `/bin/df -T smbfs <mountRoot>` 的退出状态作为 SMB 判据，不解析且不传播命令输出；可用空间仍由 `node:fs/promises.statfs` 计算。`replicateSnapshotToMountedSmb()` 与 `recoverMountedSmbSnapshot()` 在 `realpath()` 后只把 canonical `mountRoot` 传入所有 preflight/recheck，远程路径操作继续限定在同一根目录下。

**Tech Stack:** Node.js ESM、`node:test`、`node:assert`、macOS `/bin/df`、`node:fs/promises.statfs`。

## Global Constraints

- 只允许修改 `src/smb-snapshot-replication.js`、`test/smb-snapshot-replication.test.js`、`test/smb-mounted-real.integration.test.js` 与本计划文件。
- `package-lock.json` 属于用户工作区噪音：禁止读取、修改、暂存或提交。
- 禁止读取凭证、`.env`、`~/.ssh`、`~/.grok` 或 NAS 身份信息；禁止调用 `mount_smbfs`，禁止自动挂载或重连。
- 本轮真实边界只读：允许查询挂载类型和空间，禁止向真实 NAS 写文件、改文件或清理文件。
- `/bin/df` 的 stdout/stderr 不得进入返回对象、错误消息、测试报告或脱敏验收报告。
- 所有异常 fail-closed；APFS、本地目录、命令非零退出和不可用空间都不得被接受为 SMB。
- commit、push、发布和真实 NAS 写入分别保留用户硬闸。
- 正常态：真实 SMB 返回 `{ fsType: 'smbfs', availableBytes: safe-integer }`；复制/恢复的每次探测都接收同一个 canonical mount root。
- 恢复锚点：Git `f7d47fe93590d0d53a037d287413dd28157bc294`；实现失败时保留测试证据并回到该 last-green，禁止未经授权执行 destructive reset/restore。

## Runtime Resilience Gate

- 有界失效（Task 1、Task 2）：`df` 非零、`statfs` 失败、非 SMB 或空间异常均映射到既有 fail-closed 错误；无降级到 `/usr/bin/stat` 或 APFS。
- 异常恢复（Task 2）：复制中探测失败继续返回 `replication-copy-failed`；显式 stale recovery 使用 canonical root，失败时保留 lock/staging 的既有恢复锚点。
- 状态侦测与运行后自检（Task 1、Task 3）：真实 macOS SMB 正向门、APFS 负向门、周期复检测试与全量回归共同证明探测信号有效。
- 最高风险失败演练（Task 3）：在复制进入发布前让复检从 `smbfs` 变为非 SMB，确认操作 fail-closed 且不发布 `COMPLETED.json`。
- 队列、凭证迁移、调度、告警阈值：N/A；本任务只修现有本地 CLI 的文件系统探测边界，不新增队列、凭证、服务或调度器。

---

### Task 1: 建立真实 SMB 与固定适配器契约 RED

**Files:**
- Modify: `test/smb-snapshot-replication.test.js:638`
- Create: `test/smb-mounted-real.integration.test.js`

**Interfaces:**
- Consumes: `inspectMountedSmb(mountPath, deps = {})`。
- Produces: 固定 `/bin/df` 调用契约、真实 SMB 正向门、APFS 负向门。

- [ ] **Step 1: 把现有适配器单测改成目标契约**

```js
it('inspectMountedSmb uses fixed /bin/df smbfs probe and statfs available bytes', async () => {
  const calls = [];
  const result = await inspectMountedSmb('/Volumes/TestShare', {
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'must-not-be-parsed', stderr: 'must-not-be-returned' };
    },
    statfs: async (path) => {
      calls.push({ path });
      return { bavail: 100n, bsize: 4096n };
    },
  });
  assert.deepStrictEqual(calls, [
    { file: '/bin/df', args: ['-T', 'smbfs', '/Volumes/TestShare'] },
    { path: '/Volumes/TestShare' },
  ]);
  assert.deepStrictEqual(result, { fsType: 'smbfs', availableBytes: 409600 });
});
```

- [ ] **Step 2: 新增 macOS 真实只读边界测试**

```js
import { it } from 'node:test';
import assert from 'node:assert';
import { inspectMountedSmb } from '../src/smb-snapshot-replication.js';

const realGate = process.platform === 'darwin'
  && process.env.LINKE_REAL_SMB_INSPECTION === 'enabled';

it('rejects the local APFS root as SMB on macOS', {
  skip: process.platform !== 'darwin',
}, async () => {
  await assert.rejects(() => inspectMountedSmb('/'));
});

it('recognizes an operator-mounted SMB share without writing to it', {
  skip: !realGate,
}, async () => {
  const mountPath = process.env.LINKE_REAL_SMB_MOUNT_PATH;
  assert.ok(typeof mountPath === 'string' && mountPath.startsWith('/Volumes/'));
  let result;
  try {
    result = await inspectMountedSmb(mountPath);
  } catch {
    assert.fail('sanitized real SMB inspection failed');
  }
  assert.equal(result.fsType, 'smbfs');
  assert.ok(Number.isSafeInteger(result.availableBytes) && result.availableBytes > 0);
});
```

When the real gate is enabled but `LINKE_REAL_SMB_MOUNT_PATH` is absent or not an absolute `/Volumes/...` path, fail with a fixed sanitized assertion message; do not silently skip and do not include the received value.

- [ ] **Step 2a: 锁定 adapter rejection 透传**

Add two unit tests: one injects an `execFile` rejection and asserts `inspectMountedSmb()` rejects without calling `statfs`; the other lets `execFile` resolve with arbitrary stdout/stderr, injects a `statfs` rejection, and asserts the rejection propagates. Assertions must use fixed errors/messages and must not include a mount path or child-process output.

- [ ] **Step 3: Codex 在父版本验证有效 RED**

Run:

```bash
node --test --test-name-pattern='inspectMountedSmb uses fixed|rejects the local APFS|recognizes an operator-mounted SMB' test/smb-snapshot-replication.test.js test/smb-mounted-real.integration.test.js
```

Run the positive hardware gate separately with `LINKE_REAL_SMB_INSPECTION=enabled` and `LINKE_REAL_SMB_MOUNT_PATH` set by the operator environment.

Expected: 固定适配器单测因仍调用 `/usr/bin/stat` 失败；真实 SMB 正向门因当前结果为 `/` 而失败；APFS 负向门因旧实现错误成功返回而失败。失败必须来自缺少目标行为，而非语法、导入或 fixture 错误。

### Task 2: 最小实现与 canonical mount root 一致性

**Files:**
- Modify: `src/smb-snapshot-replication.js:284-299,993-1143,1359-1516`
- Modify: `test/smb-snapshot-replication.test.js`

**Interfaces:**
- Consumes: Task 1 的 `inspectMountedSmb()` 行为契约。
- Produces: `inspectMountedSmb()` 返回固定 `fsType: 'smbfs'`；复制和恢复的 `inspectMount(path)` 只接收 `mountRoot`。

- [ ] **Step 1: 新增复制 canonical path RED**

Use `createExecutionFixture(t)`, compute `const expectedRoot = await realpath(mountPath)` with the real `node:fs/promises.realpath`, set `mountedShare.mountPath` to `` `${mountPath}/.` ``, collect every `inspectMount(path)`, run the real replication fixture, then assert at least two checks and every path strictly equals `expectedRoot`. This prevents macOS `/var` → `/private/var` aliases from polluting the RED/GREEN reason.

- [ ] **Step 2: 新增恢复 canonical path RED**

Use the existing stale lock/staging fixture, compute `const expectedRoot = await realpath(fixture.mountPath)` with the real filesystem API, set the configured path to `` `${fixture.mountPath}/.` ``, collect each recovery `inspectMount(path)`, and assert the recovered state plus at least two checks all strictly equal `expectedRoot`.

- [ ] **Step 3: 运行 canonical path RED**

```bash
node --test --test-name-pattern='canonical mount root' test/smb-snapshot-replication.test.js
```

Expected: current implementation passes the raw `/.` path and fails strict equality.

- [ ] **Step 4: 实现最小适配器修复**

```js
/**
 * 使用固定 `/bin/df -T smbfs` 退出状态与 statfs 检查 SMB 和可用空间；
 * 禁止 shell，并丢弃命令输出。
 */
export async function inspectMountedSmb(mountPath, deps = {}) {
  const exec = deps.execFile || execFileDefault;
  const getStatfs = deps.statfs || statfs;
  await exec('/bin/df', ['-T', 'smbfs', mountPath]);
  const stats = await getStatfs(mountPath);
  return {
    fsType: 'smbfs',
    availableBytes: Number(stats.bavail) * Number(stats.bsize),
  };
}
```

- [ ] **Step 5: 统一复制与恢复调用路径**

After each `const mountRoot = await resolveMountRoot(mountPath)`, pass `mountRoot` rather than `mountPath` to every `preflightMount()` and `recheckMount()` in that operation. Do not alter remote relative path, lock, staging, publication, cleanup, retry, marker or sanitization semantics.

- [ ] **Step 6: 运行 GREEN**

```bash
node --test test/smb-snapshot-replication.test.js test/smb-mounted-real.integration.test.js
```

Expected: PASS，真实 SMB 正向用例在默认环境中仍明确 SKIP。

### Task 3: 真实只读验证、韧性演练与回归

**Files:**
- Verify only: `src/smb-snapshot-replication.js`
- Verify only: `test/smb-snapshot-replication.test.js`
- Verify only: `test/smb-mounted-real.integration.test.js`

**Interfaces:**
- Consumes: Task 2 的完整修复。
- Produces: Codex verifier 的真实边界和全量回归证据。

- [ ] **Step 1: 运行真实 macOS 只读正向门与 APFS 负向门**

Run the two tests with the explicit real gate and operator-supplied mount path. Expected: both PASS；不创建、修改或删除任何 NAS 文件。

- [ ] **Step 2: 演练最高风险复检失败链**

```bash
node --test --test-name-pattern='aborts with replication-copy-failed when mount recheck fails before publish' test/smb-snapshot-replication.test.js
```

Expected: PASS；第二次探测失败触发 `replication-copy-failed`，无成功发布。

- [ ] **Step 3: 运行焦点与全量回归**

```bash
node --test test/smb-snapshot-replication.test.js test/agent-nas-snapshot-replication.test.js test/nas-config.test.js
npm test
```

Expected: PASS；允许既有、解释明确且与本改动无关的硬件 gate SKIP，不允许新增失败或警告。

- [ ] **Step 4: 独立审查与证据统计**

GLM-5.2 fresh 只读抗辩检查 fail-closed、canonical path 和输出脱敏；Qwen 只读统计修改文件/行数/测试通过与 skip 数；Kimi K3 fresh closure reviewer 按固定 schema 输出结论。任何 timeout、空输出、schema 缺失或工具错误均为 HOLD，不得当 PASS。

- [ ] **Step 5: Commit 与 Push 人类硬闸**

只有 Codex verifier 完成 GREEN、真实只读边界与全量回归后，才展示精确 staged allowlist 与建议提交信息 `fix: correct macOS SMB mount inspection`。未获得独立明确授权，不执行 commit；未获得后续独立明确授权，不执行 push。
