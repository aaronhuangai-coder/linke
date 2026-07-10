# Mounted SMB Snapshot Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Linke 增加基于 macOS 预挂载 SMB 共享的手动 snapshot replication，并以 manifest v2、双重执行门、完成标记和显式恢复保证数据一致性。

**Architecture:** 本地备份仍由 `src/storage.js` 创建不可变 snapshot；新的 `src/smb-snapshot-replication.js` 只从已完成 snapshot 读取数据，先复制到 SMB staging，校验后转移到 final，再以 `COMPLETED.json` 作为唯一完成信号。Web/API 保持只读，真实写入只允许 Agent CLI 在 `--execute` 与 `LINKE_NAS_SMB_EXECUTION=enabled` 同时满足时触发。

**Tech Stack:** Node.js 24 ESM、Node.js 内置 `node:test`、`node:fs/promises`、`node:crypto`、`node:child_process`；不新增 npm 依赖。

## Global Constraints

- 只支持 `synology` 与 `ugreen` 的预挂载 SMB 共享；Linke 不挂载、不卸载、不重连共享。
- mounted SMB 目标只由 `mountedShare.mountPath + mountedShare.relativeRoot` 决定，必须忽略既有 `remotePath`。
- 不读取 `.env`、凭证目录、钥匙串、用户名、密码、token 或 `credentialRef` 的值。
- 无 `--execute` 时不得访问远端目录或创建任何远端状态。
- 有 `--execute` 时仍要求 `LINKE_NAS_SMB_EXECUTION=enabled`，缺一项即 fail-closed。
- Web/API 不新增真实 NAS 写入口或按钮；现有 NAS dry-run 继续固定 `wouldConnect:false`、`wouldWrite:false`。
- `COMPLETED.json` 是唯一 published/usable 信号；final 存在不等于复制完成。
- 不覆盖、不合并、不自动删除 final；冲突只返回 sanitized error code。
- 真实 SMB 验收必须使用用户明确提供的专用测试目录；本地临时目录只能作为自动化 fixture。
- 每个实现任务先运行 RED，再写最小实现，再运行 GREEN；worker 不执行 commit/push，由 Codex PM 复检后执行。
- 所有新增 exported function/class 必须有简短 JSDoc，说明输入、返回值和 fail-closed 错误语义。

## File Map

- Modify: `src/storage.js` — 创建 manifest v2，计算本地 snapshot 文件 SHA-256，拒绝符号链接和非普通文件。
- Modify: `src/config.js` — 统一校验和规范化 `nasTargets[].mountedShare`。
- Modify: `src/nas.js` — 在 NAS target/dry-run 中暴露不含路径的 mounted SMB 配置状态。
- Create: `src/smb-snapshot-replication.js` — manifest 校验、canonical digest、preflight、lock、staging、复制、发布、幂等和恢复。
- Modify: `src/agent.js` — 增加本地 `nas-snapshot-replicate` CLI，映射退出码并输出 sanitized JSON。
- Modify: `src/audit-log.js` — 扩展复制事件所需的数值/布尔 allowlist。
- Modify: `src/version.js`、`src/gold-readiness.js`、`README.md` — 仅在真实 SMB 验收通过后更新 V1.24 和 Gold partial 证据。
- Modify: `test/manifest.test.js`、`test/config.test.js`、`test/nas-dry-run.test.js` — manifest 与配置契约测试。
- Create: `test/smb-snapshot-replication.test.js` — 核心复制、幂等、失败与恢复测试。
- Create: `test/agent-nas-snapshot-replicate.test.js` — CLI 双门、退出码、脱敏与审计测试。
- Modify: `test/audit-log.test.js`、`test/gold-readiness.test.js`、`test/version.test.js`、`test/readme.test.js` — 发布证据和回归测试。
- Create after real acceptance: `docs/superpowers/reports/2026-07-10-v1.24-real-smb-acceptance.md` — 只保存脱敏验收结果，不保存真实路径或凭证。

---

### Task 1: Manifest v2 Integrity

**Files:**
- Modify: `src/storage.js`
- Modify: `test/manifest.test.js`

**Interfaces:**
- Consumes: `createBackup(dataDir, options, hooks)`、`safeDevicePath(dataDir, deviceId)`。
- Produces: manifest `{ schemaVersion: 2, files, integrity: { algorithm, totalBytes, entries } }`；`files` 与 `entries[].path` 使用 UTF-8 字节序稳定排序。

- [ ] **Step 1: 写 manifest v2 和文件类型 RED 测试**

在 `test/manifest.test.js` 增加 `symlink` import，并加入以下测试。测试必须断言精确 hash、size、排序和旧读取兼容；符号链接测试必须确认没有生成可用 manifest。

```js
it('creates manifest v2 with stable SHA-256 integrity entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linke-manifest-v2-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'z.txt'), 'z');
    await writeFile(join(source, 'nested', 'a.txt'), 'alpha');

    const snapshot = await createBackup(root, { deviceId: 'manifest-v2', sourcePath: source });
    const { deviceDir } = safeDevicePath(root, 'manifest-v2');
    const manifest = await readJSON(join(deviceDir, 'snapshots', snapshot.snapshotId, 'manifest.json'));

    assert.strictEqual(manifest.schemaVersion, 2);
    assert.deepStrictEqual(manifest.files, ['nested/a.txt', 'z.txt']);
    assert.strictEqual(manifest.integrity.algorithm, 'sha256');
    assert.strictEqual(manifest.integrity.totalBytes, 6);
    assert.deepStrictEqual(manifest.integrity.entries, [
      { path: 'nested/a.txt', size: 5, sha256: sha256('alpha') },
      { path: 'z.txt', size: 1, sha256: sha256('z') },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a symbolic link instead of creating trusted integrity evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linke-manifest-symlink-'));
  try {
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(source, 'linked.txt'));
    await assert.rejects(
      createBackup(root, { deviceId: 'manifest-symlink', sourcePath: source }),
      /unsupported backup file type/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/manifest.test.js`

Expected: FAIL，manifest 缺少 `schemaVersion`/`integrity`，符号链接未被拒绝。

- [ ] **Step 3: 在 storage 中实现流式 hash 和严格文件类型检查**

将 crypto import 合并为 `createHash, randomUUID`，从 `node:fs` 引入 `createReadStream`。复制扫描和 manifest 构建使用以下完整 helper；顶层 source 改用 `lstat`，只允许目录或普通文件。

```js
function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function hashFileSha256(filePath) {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('unsupported backup file type');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { size: entry.size, sha256: hash.digest('hex') };
}

async function buildSnapshotIntegrity(filesDir, allFiles) {
  const entries = [];
  for (const filePath of allFiles) {
    const path = relative(filesDir, filePath);
    const { size, sha256 } = await hashFileSha256(filePath);
    entries.push({ path, size, sha256 });
  }
  entries.sort((a, b) => compareUtf8Bytes(a.path, b.path));
  return {
    files: entries.map((entry) => entry.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
      entries,
    },
  };
}
```

在 `copyDirRecursive` 中明确分支：目录递归、普通文件复制、其余类型抛出 `unsupported backup file type`。manifest 构造替换为：

```js
const allFiles = await collectFilesRecursive(filesDir);
const snapshotIntegrity = await buildSnapshotIntegrity(filesDir, allFiles);
const manifest = {
  schemaVersion: 2,
  snapshotId,
  deviceId: slug,
  createdAt: new Date().toISOString(),
  hostname: hostname || 'unknown',
  ipAddress: ipAddress || 'unknown',
  sourcePath,
  files: snapshotIntegrity.files,
  integrity: snapshotIntegrity.integrity,
};
```

- [ ] **Step 4: 运行 GREEN 和本地恢复回归**

Run: `node --test test/manifest.test.js test/restore.test.js test/concurrency.test.js test/security.test.js`

Expected: PASS，且既有 manifest API/restore 行为保持兼容。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff -- src/storage.js test/manifest.test.js`

PM commit: `feat: add snapshot manifest v2 integrity`

---

### Task 2: Mounted SMB Configuration Boundary

**Files:**
- Modify: `src/config.js`
- Modify: `src/nas.js`
- Modify: `test/config.test.js`
- Modify: `test/nas-dry-run.test.js`
- Modify: `test/agent-nas-dry-run.test.js`

**Interfaces:**
- Produces: `validateNasMountedShare(value)` 返回 `null` 或 `{ enabled, mountPath, relativeRoot }`。
- Produces: normalized NAS target 增加 `mountedShare`；dry-run target 只增加 `mountedShareConfigured` 与 `mountedShareEnabled`，不得输出 mountPath/relativeRoot。

- [ ] **Step 1: 写 mountedShare RED 测试**

测试合法绝对路径、安全相对根、disabled 状态、路径穿越、相对 mountPath、符号控制字符、额外 credential 字段，以及 dry-run 输出不泄露路径。

```js
function validConfig(targetOverrides = {}) {
  return {
    serverUrl: 'http://localhost:3000',
    deviceId: 'mounted-smb-config',
    backupJobs: [{ name: 'documents', sourcePath: '/tmp/documents' }],
    nasTargets: [{
      name: 'primary-nas',
      provider: 'synology',
      endpoint: 'https://nas.example.invalid',
      shareName: 'backup',
      remotePath: '/provider-owned/path',
      enabled: true,
      ...targetOverrides,
    }],
  };
}

it('accepts and normalizes a credential-free mountedShare', () => {
  const config = validateConfig(validConfig({
    mountedShare: { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke/main' },
  }));
  assert.deepStrictEqual(config.nasTargets[0].mountedShare, {
    enabled: true,
    mountPath: '/Volumes/LinkeBackup',
    relativeRoot: 'linke/main',
  });
});

for (const mountedShare of [
  { enabled: true, mountPath: 'Volumes/relative', relativeRoot: 'linke' },
  { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: '../escape' },
  { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: '/absolute' },
  { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke', password: 'forbidden' },
]) {
  assert.throws(() => validateConfig(validConfig({ mountedShare })), /mountedShare|credential/);
}
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/config.test.js test/nas-dry-run.test.js test/agent-nas-dry-run.test.js`

Expected: FAIL，normalization 尚未保留 mountedShare。

- [ ] **Step 3: 实现单一配置校验 helper 并复用**

在 `src/config.js` 导出并使用：

```js
export function validateNasMountedShare(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nasTargets[].mountedShare must be an object');
  }
  assertNoCredentials(value);
  const allowedKeys = new Set(['enabled', 'mountPath', 'relativeRoot']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`nasTargets[].mountedShare contains unsupported field "${key}"`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('nasTargets[].mountedShare.enabled must be a boolean');
  }
  if (typeof value.mountPath !== 'string' || !isAbsolute(value.mountPath) || /[\0\r\n]/.test(value.mountPath)) {
    throw new Error('nasTargets[].mountedShare.mountPath must be an absolute safe path');
  }
  if (typeof value.relativeRoot !== 'string' || value.relativeRoot.length === 0
    || isAbsolute(value.relativeRoot) || /[\0\r\n\\]/.test(value.relativeRoot)) {
    throw new Error('nasTargets[].mountedShare.relativeRoot must be a safe relative path');
  }
  const parts = value.relativeRoot.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('nasTargets[].mountedShare.relativeRoot must not contain empty, dot, or parent segments');
  }
  return { enabled: value.enabled !== false, mountPath: value.mountPath, relativeRoot: value.relativeRoot };
}
```

`src/nas.js` 从 config import 同一 helper，`validateNasTarget` 返回 `mountedShare`。`buildNasDryRunPlan` target 只加入：

```js
mountedShareConfigured: Boolean(t.mountedShare),
mountedShareEnabled: Boolean(t.mountedShare?.enabled),
```

- [ ] **Step 4: 运行 GREEN 和敏感信息回归**

Run: `node --test test/config.test.js test/nas-dry-run.test.js test/agent-nas-dry-run.test.js test/security.test.js`

Expected: PASS；stdout 不包含 `/Volumes/LinkeBackup`、`relativeRoot` 展开值或 credential value。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff -- src/config.js src/nas.js test/config.test.js test/nas-dry-run.test.js test/agent-nas-dry-run.test.js`

PM commit: `feat: validate mounted SMB target configuration`

---

### Task 3: Replication Manifest, Digest, and Read-Only Plan

**Files:**
- Create: `src/smb-snapshot-replication.js`
- Create: `test/smb-snapshot-replication.test.js`

**Interfaces:**
- Produces: `SmbReplicationError`、`buildRemoteSnapshotManifest(localManifest)`、`serializeCanonicalRemoteManifest(remoteManifest)`、`digestRemoteSnapshotManifest(remoteManifest)`。
- Produces: `buildSmbSnapshotReplicationPlan({ config, dataDir, targetName, deviceId, snapshotId })`，只读取本地 snapshot，不访问 mountPath。

- [ ] **Step 1: 写 canonical digest、v1 blocker 和 plan 零远端访问 RED 测试**

```js
function localManifestV2(overrides = {}) {
  return {
    schemaVersion: 2,
    snapshotId: '11111111-1111-1111-1111-111111111111',
    deviceId: 'device-a',
    createdAt: '2026-07-10T00:00:00.000Z',
    files: ['a.txt'],
    integrity: {
      algorithm: 'sha256',
      totalBytes: 5,
      entries: [{
        path: 'a.txt',
        size: 5,
        sha256: '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8',
      }],
    },
    ...overrides,
  };
}

function validPlanOptions() {
  return {
    config: {
      nasTargets: [{
        name: 'primary-nas',
        provider: 'synology',
        enabled: true,
        mountedShare: { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke' },
      }],
    },
    dataDir: '/tmp/linke-plan-fixture',
    targetName: 'primary-nas',
    deviceId: 'device-a',
    snapshotId: '11111111-1111-1111-1111-111111111111',
  };
}

it('serializes the allowlisted remote manifest into stable canonical bytes', () => {
  const remote = buildRemoteSnapshotManifest(localManifestV2());
  const bytes = serializeCanonicalRemoteManifest(remote);
  assert.strictEqual(bytes, '{"schemaVersion":2,"snapshotId":"11111111-1111-1111-1111-111111111111","deviceId":"device-a","createdAt":"2026-07-10T00:00:00.000Z","files":["a.txt"],"integrity":{"algorithm":"sha256","totalBytes":5,"entries":[{"path":"a.txt","size":5,"sha256":"8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8"}]}}');
  assert.strictEqual(digestRemoteSnapshotManifest(remote), createHash('sha256').update(bytes).digest('hex'));
});

it('blocks v1 manifests with a stable migration code', async () => {
  await assert.rejects(
    buildSmbSnapshotReplicationPlan(validPlanOptions(), {
      readSnapshotManifest: async () => ({ files: ['a.txt'] }),
    }),
    (error) => error.code === 'snapshot-integrity-v2-required' && error.exitCode === 2,
  );
});

it('builds a local-only plan without inspecting or writing the mounted share', async () => {
  const calls = [];
  const plan = await buildSmbSnapshotReplicationPlan(validPlanOptions(), {
    readSnapshotManifest: async () => localManifestV2(),
    inspectMount: async () => { calls.push('inspect'); throw new Error('must not run'); },
  });
  assert.strictEqual(plan.state, 'planned');
  assert.strictEqual(plan.wouldWrite, false);
  assert.deepStrictEqual(calls, []);
  assert.ok(!JSON.stringify(plan).includes('/Volumes/'));
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern='canonical|v1|local-only' test/smb-snapshot-replication.test.js`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现严格 manifest schema 和 plan**

模块公开错误类型和固定 code：

```js
export class SmbReplicationError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.name = 'SmbReplicationError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const SMB_REPLICATION_CODES = Object.freeze({
  EXECUTION_BLOCKED: 'smb-execution-blocked',
  MOUNT_REQUIRED: 'smb-mount-required',
  SPACE_INSUFFICIENT: 'smb-space-insufficient',
  V2_REQUIRED: 'snapshot-integrity-v2-required',
  SNAPSHOT_INTEGRITY_FAILED: 'snapshot-integrity-failed',
  LOCK_HELD: 'replication-lock-held',
  RECOVERY_REQUIRED: 'recovery_required',
  REMOTE_CONFLICT: 'remote-snapshot-conflict',
  REMOTE_INTEGRITY_FAILED: 'remote-snapshot-integrity-failed',
  COPY_FAILED: 'replication-copy-failed',
});
```

`buildRemoteSnapshotManifest` 必须重建 allowlist 对象并验证：schemaVersion、UUID-like snapshotId、slug-safe deviceId、ISO createdAt、文件一一对应、UTF-8 排序、非负安全整数、64 位小写 hash。`buildSmbSnapshotReplicationPlan` 默认通过 `getSnapshotManifest` 读取本地 manifest，并允许测试注入 `readSnapshotManifest`；canonical serializer 只能对该受限对象执行 `JSON.stringify`。plan 输出固定 allowlist：

```js
return {
  command: 'nas-snapshot-replicate',
  mode: 'plan',
  state: 'planned',
  provider: target.provider,
  targetName: target.name,
  deviceId: remoteManifest.deviceId,
  snapshotId: remoteManifest.snapshotId,
  manifestDigest,
  fileCount: remoteManifest.files.length,
  totalBytes: remoteManifest.integrity.totalBytes,
  wouldWrite: false,
  executionRequired: true,
};
```

- [ ] **Step 4: 运行 GREEN 与 3 组 golden vectors**

Run: `node --test --test-name-pattern='canonical|v1|local-only|golden' test/smb-snapshot-replication.test.js`

Expected: PASS，三组 digest 使用硬编码期望值，不在断言中调用被测 serializer 生成 expected。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff -- src/smb-snapshot-replication.js test/smb-snapshot-replication.test.js`

PM commit: `feat: add SMB replication manifest plan`

---

### Task 4: SMB Preflight and Happy-Path Publication

**Files:**
- Modify: `src/smb-snapshot-replication.js`
- Modify: `test/smb-snapshot-replication.test.js`

**Interfaces:**
- Produces: `inspectMountedSmb(mountPath, deps)`，真实实现固定调用 `/usr/bin/stat -f %T <mountPath>` 并使用 `statfs` 计算可用空间。
- Produces: `replicateSnapshotToMountedSmb(options, deps)`，首次成功返回 sanitized `state:'replicated'`，重复成功返回 `state:'already_verified'`。

- [ ] **Step 1: 写 preflight、首次复制、幂等早返回和 final 冲突 RED 测试**

测试使用临时目录模拟远端，仅通过注入 `inspectMount` 返回 `{ fsType:'smbfs', availableBytes }` 绕过真实 SMB；必须覆盖：非 smbfs、按 `totalBytes + max(64 MiB, totalBytes * 5%)` 判断空间不足、首次 publish、完成标记字段、重复运行无新 staging、损坏 final 不覆盖、publish 前 mount 复检失败、`relativeRoot` symlink 指向 mountPath 外部。

```js
async function createExecutionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'linke-smb-execute-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const mountPath = join(root, 'mounted-share');
  await mkdir(source, { recursive: true });
  await mkdir(mountPath, { recursive: true });
  await writeFile(join(source, 'a.txt'), 'alpha');
  const snapshot = await createBackup(root, { deviceId: 'device-a', sourcePath: source });
  const options = {
    config: {
      nasTargets: [{
        name: 'primary-nas',
        provider: 'synology',
        enabled: true,
        mountedShare: { enabled: true, mountPath, relativeRoot: 'linke-test' },
      }],
    },
    dataDir: root,
    targetName: 'primary-nas',
    deviceId: 'device-a',
    snapshotId: snapshot.snapshotId,
    execute: true,
    executionGate: 'enabled',
  };
  return {
    options,
    stagingParent: join(mountPath, 'linke-test', '.linke-control', 'staging', 'device-a', snapshot.snapshotId),
  };
}

async function freshExecutionOptions(t) {
  return (await createExecutionFixture(t)).options;
}

const deps = {
  inspectMount: async () => ({ fsType: 'smbfs', availableBytes: 1024 * 1024 * 1024 }),
};
const { options, stagingParent } = await createExecutionFixture(t);
const first = await replicateSnapshotToMountedSmb(options, deps);
assert.strictEqual(first.state, 'replicated');
const second = await replicateSnapshotToMountedSmb(options, deps);
assert.strictEqual(second.state, 'already_verified');
assert.strictEqual((await readdir(stagingParent)).length, 0);

await assert.rejects(
  replicateSnapshotToMountedSmb(await freshExecutionOptions(t), {
    inspectMount: async () => ({ fsType: 'smbfs', availableBytes: (64 * 1024 * 1024) + 4 }),
  }),
  (error) => error.code === 'smb-space-insufficient' && error.exitCode === 2,
);

let mountChecks = 0;
await assert.rejects(
  replicateSnapshotToMountedSmb(await freshExecutionOptions(t), {
    inspectMount: async () => {
      mountChecks += 1;
      return mountChecks === 1
        ? { fsType: 'smbfs', availableBytes: 1024 * 1024 * 1024 }
        : { fsType: 'apfs', availableBytes: 1024 * 1024 * 1024 };
    },
  }),
  (error) => error.code === 'replication-copy-failed',
);
```

`freshExecutionOptions(t)` 使用与 `createExecutionFixture(t)` 相同的构造过程，但创建新的 root/snapshot，避免已完成 final 触发 `already_verified` 早返回。symlink-escape 测试在 mountPath 下创建 `relativeRoot` 符号链接指向 root 外目录，断言 preflight 阻断且外目录保持为空。

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern='preflight|replicated|already_verified|conflict' test/smb-snapshot-replication.test.js`

Expected: FAIL，execute pipeline 尚未实现。

- [ ] **Step 3: 实现真实 mount inspector 和发布 pipeline**

真实 inspector 使用固定 executable/args，禁止 shell：

```js
export async function inspectMountedSmb(mountPath, deps = {}) {
  const exec = deps.execFile || promisify(execFile);
  const getStatfs = deps.statfs || statfs;
  const { stdout } = await exec('/usr/bin/stat', ['-f', '%T', mountPath]);
  const fsType = stdout.trim();
  const stats = await getStatfs(mountPath);
  return { fsType, availableBytes: Number(stats.bavail) * Number(stats.bsize) };
}
```

execute 顺序必须是：双门与 target 校验 → 本地文件重新 lstat/hash → mountPath 自身 lstat/realpath 边界 → smbfs/空间 preflight → exclusive lock → lock 内幂等验证 → attempt staging → 流式复制 → staging 全量校验 → 写 remote manifest → rename 到不存在的 final → final 全量校验 → 原子写 `COMPLETED.json` → 清理本次 lock。

空间门固定计算：

```js
const safetyMargin = Math.max(64 * 1024 * 1024, Math.ceil(totalBytes * 0.05));
if (!Number.isSafeInteger(availableBytes) || availableBytes < totalBytes + safetyMargin) {
  throw new SmbReplicationError('smb-space-insufficient', 2);
}
```

路径边界必须先取得 `mountRoot = await realpath(mountPath)`，再使用 `path.relative(mountRoot, candidateRealPath)` 验证每个已存在目录仍在根内；禁止使用字符串 `startsWith`。创建 relativeRoot/control/staging/final 的每一级前后都执行 `lstat`，拒绝符号链接和非目录，并在创建后重新 `realpath + relative` 验证。

完成标记只允许：

```js
const completed = {
  schemaVersion: 1,
  state: 'completed',
  snapshotId,
  deviceId,
  manifestDigest,
  algorithm: 'sha256',
  fileCount,
  totalBytes,
  completedAt: now().toISOString(),
  linkeVersion: LINKE_RELEASE_VERSION,
};
```

复制过程中每 50 个文件或 100 MiB、以及 publish 前调用 `inspectMount` 复检同一 smbfs。单文件使用 stream pipeline 并更新 progress timestamp；120 秒无进度时抛 `replication-copy-failed`。

- [ ] **Step 4: 运行 GREEN**

Run: `node --test --test-name-pattern='preflight|replicated|already_verified|conflict' test/smb-snapshot-replication.test.js`

Expected: PASS；临时 fixture final 只在 hash 完整后出现有效 `COMPLETED.json`。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && node --test test/smb-snapshot-replication.test.js`

PM commit: `feat: publish snapshots to mounted SMB staging`

---

### Task 5: Lock, Retry, and Failure Cleanup

**Files:**
- Modify: `src/smb-snapshot-replication.js`
- Modify: `test/smb-snapshot-replication.test.js`

**Interfaces:**
- Lock schema: `{ schemaVersion, attemptId, ownerToken, deviceId, snapshotId, manifestDigest, createdAt, heartbeatAt }`。
- attempt metadata schema: 同一 attempt identity，不含本地或远端绝对路径。
- Retry: 仅 pre-publish 可重试 I/O 错误一次；ENOSPC、EACCES、路径/完整性错误不重试。

- [ ] **Step 1: 写并发、heartbeat、重试和 cleanup RED 测试**

使用可控 `copyFile`/`now`/`setInterval` 依赖覆盖：同一 snapshot 第二执行返回 `replication-lock-held`；不同 snapshot 可并行；可重试错误只重试一次；EACCES 不重试；handled failure 只删除 ownerToken 匹配的 staging/lock；共享不可达导致清理失败时保留残留且无完成标记。

```js
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const lockReady = deferred();
const releaseCopy = deferred();
const first = replicateSnapshotToMountedSmb(options, {
  ...deps,
  beforeCopy: async () => {
    lockReady.resolve();
    await releaseCopy.promise;
  },
});
await lockReady.promise;
await assert.rejects(
  replicateSnapshotToMountedSmb(options, deps),
  (error) => error.code === 'replication-lock-held',
);
releaseCopy.resolve();
await first;
```

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern='lock|retry|cleanup|heartbeat' test/smb-snapshot-replication.test.js`

Expected: FAIL，租约和有界重试尚不完整。

- [ ] **Step 3: 实现 compare-and-delete、heartbeat 与有界 retry**

lock 使用 `open(lockPath, 'wx')`。heartbeat 每 30 秒先重新读取 lock，只有 ownerToken/attemptId 都匹配才通过临时文件 + rename 更新。cleanup 必须重新读取 lock 和 attempt metadata；任何 identity 不一致都不删除。retry predicate 固定：

```js
const RETRYABLE_IO_CODES = new Set(['EIO', 'EHOSTDOWN', 'ENETDOWN', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT']);

function canRetryBeforePublish(error, retryCount, published) {
  return !published && retryCount < 1 && RETRYABLE_IO_CODES.has(error?.code);
}
```

rename 报错或结果不确定时将 pipeline 标记为 `recovery_required`，不得删除 staging/final。普通 copy failure 可达时只清理 owned staging；清理本身失败不得覆盖原始 sanitized code。

- [ ] **Step 4: 运行 GREEN 和故障注入测试**

Run: `node --test --test-name-pattern='lock|retry|cleanup|heartbeat|disconnect|rename' test/smb-snapshot-replication.test.js`

Expected: PASS；失败场景均无有效完成标记，且 `retryCount <= 1`。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && node --test test/smb-snapshot-replication.test.js`

PM commit: `feat: harden SMB replication concurrency failures`

---

### Task 6: Explicit Stale Recovery

**Files:**
- Modify: `src/smb-snapshot-replication.js`
- Modify: `test/smb-snapshot-replication.test.js`

**Interfaces:**
- `recoverMountedSmbSnapshot(options, deps)` 仅在 execute 双门满足时运行。
- stale threshold 固定 30 分钟；未 stale、identity 不匹配、final 不一致均 fail-closed。

- [ ] **Step 1: 写 stale recovery RED 测试**

覆盖：默认 execute 遇到 stale lock 返回 `recovery_required` 且不删除；`recover:true` 清理完全匹配的 stale lock/staging；heartbeat 未超过 30 分钟不可恢复；metadata 不匹配不可恢复；rename 后 final 完整可补完成标记；final 不完整返回 conflict 且不删除。

```js
async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

await assert.rejects(
  replicateSnapshotToMountedSmb(options, deps),
  (error) => error.code === 'recovery_required' && error.exitCode === 3,
);
assert.ok(await pathExists(staleStaging));

const recovered = await recoverMountedSmbSnapshot({ ...options, recover: true }, deps);
assert.strictEqual(recovered.state, 'recovered');
assert.strictEqual(await pathExists(staleStaging), false);
```

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern='recover|stale|missing marker' test/smb-snapshot-replication.test.js`

Expected: FAIL，显式恢复函数尚未实现。

- [ ] **Step 3: 实现严格恢复状态机**

恢复必须重新执行：execution gate → config/target → local manifest digest → mount smbfs → lock heartbeat age → lock/staging metadata identity。允许的两个动作只有：

```js
if (finalExists) {
  await verifyFinalAgainstManifest(context);
  await writeCompletedMarker(context);
  await compareAndDeleteOwnedLock(context);
  return sanitizedResult('recovered', context);
}

await verifyStagingMetadata(context);
await removeOwnedStaging(context);
await compareAndDeleteOwnedLock(context);
await runPreflight(context);
return sanitizedResult('recovered', context);
```

在执行 `removeOwnedStaging(context)` 前必须显式调用 `await verifyStagingMetadata(context)`，并在删除后再次确认 lock 的 ownerToken/attemptId 未变化；任一不匹配都返回 `remote-snapshot-conflict`，不得继续清理。

禁止恢复函数删除 final。final 任一文件集合、size/hash 或 remote manifest digest 不一致时抛 `remote-snapshot-conflict`。

- [ ] **Step 4: 运行 GREEN**

Run: `node --test test/smb-snapshot-replication.test.js`

Expected: PASS，所有 recovery/failure 状态组合闭合。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && node --test test/smb-snapshot-replication.test.js`

PM commit: `feat: add explicit SMB replication recovery`

---

### Task 7: Agent CLI and Sanitized Audit

**Files:**
- Modify: `src/agent.js`
- Modify: `src/audit-log.js`
- Create: `test/agent-nas-snapshot-replicate.test.js`
- Modify: `test/audit-log.test.js`

**Interfaces:**
- CLI: `node src/agent.js nas-snapshot-replicate --config <path> --data-dir <path> --target <name> --device-id <id> --snapshot-id <id> [--execute] [--recover]`。
- Exit codes: success/planned/already_verified/recovered `0`；failed `1`；blocked `2`；recovery_required `3`。
- Audit events: `nas.snapshot.replication.planned|started|completed|already_verified|failed|recovery_required|recovered`。

- [ ] **Step 1: 写 CLI 双门、退出码、脱敏、无 Web/API 面 RED 测试**

测试必须通过 `execFile('node', [agentPath, ...args], { env })` 启动真实 CLI。覆盖 required args、flag 不接受值、`--recover` 必须配合 `--execute`、无 execute 零远端写、环境门缺失退出 2、成功/幂等/恢复退出码，以及 stdout/stderr 不含 configPath、dataDir、mountPath、remotePath、endpoint、credentialRef、ownerToken、sourcePath 或原始系统错误。

```js
const result = JSON.parse(stdout);
assert.deepStrictEqual(Object.keys(result).sort(), [
  'command', 'deviceId', 'fileCount', 'manifestDigest', 'mode', 'provider',
  'retryCount', 'snapshotId', 'state', 'targetName', 'totalBytes', 'verifiedFileCount',
].sort());
for (const forbidden of sensitiveFixtures) {
  assert.ok(!stdout.includes(forbidden));
  assert.ok(!stderr.includes(forbidden));
}
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/agent-nas-snapshot-replicate.test.js test/audit-log.test.js`

Expected: FAIL，CLI command 和 audit allowlist 尚未存在。

- [ ] **Step 3: 接入 CLI 与 audit**

`src/agent.js` import `buildSmbSnapshotReplicationPlan`、`replicateSnapshotToMountedSmb`、`recoverMountedSmbSnapshot`、`SmbReplicationError` 和 `appendAuditEvent`。新增 command case 时先拒绝 `--execute/--recover` 的值形态和额外写入型参数，再构造 options。错误映射只使用 `SmbReplicationError.code/exitCode`，普通异常统一输出 `nas-snapshot-replicate-failed`，不回显 `err.message`。

该 command 只接受 `_`、`config`、`data-dir`、`target`、`device-id`、`snapshot-id`、`execute`、`recover`。任何其它参数，包括 `username`、`password`、`token`、`credential`、`smb-url`、`command`、`shell`，都返回固定 `smb-arguments-invalid` 并退出 1，不回显参数名或参数值：

```js
const NAS_REPLICATION_ARG_KEYS = new Set([
  '_', 'config', 'data-dir', 'target', 'device-id', 'snapshot-id', 'execute', 'recover',
]);

function assertNasReplicationArgs(args) {
  if (Object.keys(args).some((key) => !NAS_REPLICATION_ARG_KEYS.has(key))) {
    throw new SmbReplicationError('smb-arguments-invalid', 1);
  }
}
```

```js
case 'nas-snapshot-replicate': {
  assertNasReplicationArgs(args);
  requireValue(args, 'config');
  requireValue(args, 'data-dir');
  requireValue(args, 'target');
  requireValue(args, 'device-id');
  requireValue(args, 'snapshot-id');
  assertBooleanFlag(args, 'execute');
  assertBooleanFlag(args, 'recover');
  if (args.recover === true && args.execute !== true) {
    throw new SmbReplicationError('smb-execution-blocked', 2);
  }
  const config = validateConfig(await loadConfig(args.config));
  const replicationOptions = {
    config,
    dataDir: args['data-dir'],
    targetName: args.target,
    deviceId: args['device-id'],
    snapshotId: args['snapshot-id'],
    execute: args.execute === true,
    recover: args.recover === true,
    executionGate: process.env.LINKE_NAS_SMB_EXECUTION,
  };
  const result = args.recover === true
    ? await recoverMountedSmbSnapshot(replicationOptions)
    : args.execute === true
      ? await replicateSnapshotToMountedSmb(replicationOptions)
      : await buildSmbSnapshotReplicationPlan(replicationOptions);
  console.log(JSON.stringify(result, null, 2));
  break;
}
```

不要让该 case 走现有会回显任意 `err.message` 的通用 catch；在 command 内捕获并打印固定 `Error: <code>`。audit allowlist 增加 `targetName`、`deviceId`、`snapshotId`、`attemptId`、`errorCode` 字符串字段，以及 `totalBytes`、`verifiedFileCount`、`retryCount` 非负整数和安全布尔字段。

- [ ] **Step 4: 运行 GREEN 和边界回归**

Run: `node --test test/agent-nas-snapshot-replicate.test.js test/audit-log.test.js test/agent-audit-log.test.js test/security.test.js test/server.test.js test/web-console.test.js`

Expected: PASS；没有新增 NAS write API route、Web button 或 server handler。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff -- src/agent.js src/audit-log.js test/agent-nas-snapshot-replicate.test.js test/audit-log.test.js`

PM commit: `feat: add guarded SMB replication CLI`

---

### Task 8: Documentation, Real SMB Acceptance, and Gold Promotion

**Files:**
- Modify: `README.md`
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`
- Create only after real success: `docs/superpowers/reports/2026-07-10-v1.24-real-smb-acceptance.md`

**Interfaces:**
- Release version becomes `V1.24` only after automated suite and real SMB acceptance both pass。
- Gold `real-nas-remote-backup` becomes `partial`，overall summary becomes `{ ready: 4, partial: 5, blocked: 0, total: 9 }` and overall status `partial`。

- [ ] **Step 1: 先写发布证据 RED 测试，但保持未验收状态不提交伪证据**

更新测试期望 V1.24、Gold partial、真实报告路径、CLI/核心测试证据和 README 限制语句：

```js
assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.24');
assert.strictEqual(report.status, 'partial');
assert.deepStrictEqual(report.summary, { ready: 4, partial: 5, blocked: 0, total: 9 });
const nas = report.items.find((item) => item.id === 'real-nas-remote-backup');
assert.strictEqual(nas.status, 'partial');
const evidence = evidenceText(nas);
assert.ok(evidence.includes('src/smb-snapshot-replication.js'));
assert.ok(evidence.includes('test/smb-snapshot-replication.test.js'));
assert.ok(evidence.includes('test/agent-nas-snapshot-replicate.test.js'));
assert.ok(evidence.includes('docs/superpowers/reports/2026-07-10-v1.24-real-smb-acceptance.md'));
assert.match(nas.nextStep, /remote restore|vendor app API|automatic scheduling|production hardening/i);
```

- [ ] **Step 2: 运行自动化候选套件**

Run: `node --test test/manifest.test.js test/config.test.js test/nas-dry-run.test.js test/smb-snapshot-replication.test.js test/agent-nas-snapshot-replicate.test.js test/audit-log.test.js test/gold-readiness.test.js test/version.test.js test/readme.test.js`

Expected before docs/version promotion: 新增发布测试 RED；核心复制测试必须 GREEN。若核心复制测试失败，停止，不进入真实 SMB 验收。

- [ ] **Step 3: 在用户提供的专用预挂载 SMB 测试目录执行真实验收**

先用 `/usr/bin/stat -f %T <mountPath>` 确认输出精确 `smbfs`。然后按 design spec 顺序执行：plan 零写入、首次 replicated、重复 already_verified、同 snapshot 并发锁竞争、损坏文件 fail-closed、stale lock/staging 显式恢复、rename 后无标记恢复。所有写入和清理只限用户明确提供的 `mountedShare.relativeRoot` 下本次随机 acceptance namespace。

真实命令形态：

```bash
node src/agent.js nas-snapshot-replicate \
  --config <user-approved-test-config> \
  --data-dir <temporary-local-data-dir> \
  --target <test-target-name> \
  --device-id <acceptance-device-id> \
  --snapshot-id <acceptance-snapshot-id> \
  --execute
```

环境门只作用于该命令进程：`LINKE_NAS_SMB_EXECUTION=enabled`。不得打印环境、配置内容、真实路径或凭证。若用户尚未提供专用 SMB 测试目录，本步骤状态为 `BLOCKED`，不得创建报告或提升 Gold。

- [ ] **Step 4: 写 sanitized 真实验收报告并完成 README/Gold/version**

报告只允许以下字段，不记录真实路径、IP、endpoint、shareName、credentialRef 或 ownerToken：

```markdown
# Linke V1.24 Real SMB Acceptance

- Provider: synology | ugreen
- Filesystem: smbfs
- Plan zero-write: PASS
- First replication: PASS
- Idempotent replay: PASS
- Concurrent lock: PASS
- Corruption fail-closed: PASS
- Stale recovery: PASS
- Final hash verification: PASS
- Sensitive output scan: PASS
- Test namespace cleaned: PASS | RETAINED_FOR_INVESTIGATION
```

README 必须说明：预挂载要求、双重执行门、v1 需从原来源重建、conflict 人工取证流程、Web/API 无真实写入口，以及 partial 不能作为唯一生产备份策略。`src/gold-readiness.js` 证据必须引用真实报告，不得只引用自动化 fixture。

- [ ] **Step 5: 运行全量验证**

Run: `npm test`

Expected: `fail 0`、`cancelled 0`。随后运行：

Run: `git diff --check && git status --short && git diff --stat`

Expected: 仅包含 V1.24 计划内文件，无 `.env`、credential、secret、临时 SMB 数据或未脱敏配置。

- [ ] **Step 6: DeepSeek fresh review 与 Codex PM 最终验收**

DeepSeek 只读审核完整 diff、自动测试摘要和 sanitized 真实 SMB 报告，必须给出结构化 `APPROVE/REVISE`。Codex PM 独立复跑全量测试、核对 Gold summary、检查 Web/API 无写入口、检查远端测试 namespace 清理状态。

- [ ] **Step 7: PM 提交推送并进入下一 Gold 版本**

PM commit: `feat: release guarded SMB snapshot replication`

PM push: `git push origin linke-v0.12-web-panel`

完成后下一阶段从剩余 Gold partial 中选择：远端 restore、自动调度、厂商 app API 或 production hardening；不得宣称 Gold ready。
