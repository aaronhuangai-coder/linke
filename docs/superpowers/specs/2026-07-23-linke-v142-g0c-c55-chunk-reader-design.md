# Linke V1.42 G0c C5.5 — 真实快照分块读取器设计

## 目标

在 C6 首次公开 `/agent/restore/*` 前，补齐当前仅由测试 mock 提供的 `storageReader.readChunk`。本阶段仍无 HTTP 路由、无 runtime 接线、无 Gold 声明。

## 决策

不扩展 `createRestoreSnapshotReader` 的精确单方法 surface。新增：

```js
createRestoreChunkReader({
  dataDir,
  taskStore,
  snapshotReader,
  openSafeRootRelativeReadFn?,
  safeDevicePathFn?,
}) -> Object.freeze({ readChunk })
```

`restore-snapshot-reader` 继续只负责权威 manifest 规范化；`restore-task-store` 新增内部服务方法 `resolveChunkRead(input)`，在单个 store device lock 内原子完成 task 身份、状态和 chunk 坐标校验；`restore-chunk-reader` 负责 manifest 复核与真实字节读取。

## 原子 descriptor

`resolveChunkRead({ deviceId, taskId, fileIndex, chunkIndex })` 只允许 active task，并返回冻结的：

```text
{
  deviceId,
  taskId,
  snapshotId,
  manifestDigest,
  fileIndex,
  chunkIndex,
  path,
  fileSize,
  fileSha256,
  chunkCount,
  chunkOffset,
  chunkSize
}
```

规则：

- 非法 input/index、空文件 chunk、越界 chunk -> `restore-task-invalid`。
- 同设备已知但非 active -> `restore-task-conflict`。
- 跨设备或不存在 -> `restore-task-not-found`。
- descriptor 阶段再次执行 snapshot-root-relative path 校验；即使 `FILES.json` 被篡改，也不得进入 I/O。
- `chunkOffset = chunkIndex * 8 MiB` 必须为 safe integer。
- 非最后 chunk 精确 8 MiB；最后 chunk 1..8 MiB。

## 读取流程

`readChunk(input)`：

1. 调用 `taskStore.resolveChunkRead(input)`，保留其 `LinkeError` 原样。
2. 调用 `snapshotReader.assertSnapshotReadable(deviceId, snapshotId)`。
3. 权威 `manifestDigest`、fileIndex、path、size、sha256、chunkCount 必须与 descriptor 全等；漂移 -> `restore-integrity-failed`。
4. 用 `safeDevicePath` 推导 controller 内部相对路径：`repo/devices/<slug>/snapshots/<snapshotId>/files/<safe path>`；路径不进入响应、日志或错误。
5. `openSafeRootRelativeRead` 完成祖先 no-follow + leaf `O_RDONLY|O_NOFOLLOW` + regular-file 检查。
6. 同一 fd 第一次 `fstat`：regular、size 与 manifest fileSize 全等；记录 dev/ino/size/mode。
7. 仅分配 `chunkSize <= 8 MiB`，从 `chunkOffset` 循环精确读取；short read 继续，early EOF/over-read/异常 -> integrity-failed。
8. 同一 fd 第二次 `fstat`：type/dev/ino/size/mode 不变；否则 integrity-failed。
9. 所有路径关闭 fd；返回 `{ body, chunkOffset, chunkSize }`。`restore-service` 继续从 body 重算 `X-Linke-Chunk-Sha256`。

任何非 task-domain `LinkeError` 的底层 I/O、symlink、路径、errno、stack 均统一脱敏为 `restore-integrity-failed`。`openSafeRootRelativeRead` 会原样抛出的 `ENOENT` 也必须在 reader 边界显式转换，绝不透传裸错误。

## 完整性边界

- 服务端保证 manifest/task 元数据一致、文件尺寸一致、请求区间精确、同 fd 读取稳定、传输 chunk SHA 从 body 重算。
- task 中的完整文件 SHA 由 endpoint 在全部 chunk 落盘后再次计算并比对；C5.5 不为每个 chunk 重扫整个大文件，避免 O(fileSize × chunkCount)。
- controller snapshot 在本协议中是已提交不可变树；若内容被同 inode 等长篡改，endpoint 的完整文件 SHA 必须 fail-close，且不得进入 publish。
- active 状态在 descriptor 解析时判定；随后状态切到 cancel/terminal 不撤销已开始的单个 immutable chunk 读取，endpoint 仍按 cancelRequested 收敛。
- 每 chunk 权威 manifest 复核的成本受既有 `UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES` 上界约束；不得改为每 chunk 全文件重哈希。

## C6 生产接线

```js
const restoreSnapshotReader = createRestoreSnapshotReader({
  dataDir,
  getSnapshotManifestFn: getSnapshotManifest,
});
const restoreTaskStore = createRestoreTaskStore({
  dataDir,
  now,
  storageReader: restoreSnapshotReader,
});
const restoreChunkReader = createRestoreChunkReader({
  dataDir,
  taskStore: restoreTaskStore,
  snapshotReader: restoreSnapshotReader,
});
const restoreService = createRestoreService({
  taskStore: restoreTaskStore,
  storageReader: restoreChunkReader,
  locks,
  findActiveUpload,
});
```

C6 在此真实 reader 未通过独立复审前继续 HOLD。
