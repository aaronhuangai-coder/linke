# Linke V1.42 G0c C5.5 — 真实分块读取器实施计划

**目标：** 用真实、受边界约束的 controller snapshot reader 替代 C5 的 `readChunk` mock 缺口；不开放路由。

**范围：**

- Create: `src/restore-chunk-reader.js`
- Create: `test/restore-chunk-reader.test.js`
- Modify: `src/restore-task-store.js`
- Modify: `test/restore-task-store.test.js`
- Docs: 本设计与计划；原 C6 runtime wiring 后续改用 chunk reader

**禁止：** 修改 listener/server/controller-runtime；修改 upload 语义；读取或暂存 `package-lock.json`；用 mock 作为生产接线证据。

## RED

1. Grok 只写测试：
   - task store surface 新增 `resolveChunkRead`。
   - active 成功 descriptor；pending/completed/rolled-back/cancelled/cleaned 必须为 `restore-task-conflict`，不得复用 progress 的 `restore-task-invalid`。
   - cross-device/not-found；非法/越界/空文件 chunk；safe-int 乘法。
   - reader constructor exact/frozen surface。
   - manifest digest/file metadata 漂移；symlink/目录/缺失（裸 ENOENT 必须脱敏）/size mismatch；short read/early EOF；第二次 fstat 变化；close-on-all-paths。
   - 真实 local 与 remote-upload fixture 的 8 MiB、尾块、并行只读。
   - 错误不含 path/errno/token/stack。
2. Codex PM 必须独立见证新增测试 RED，既有 C2/C5 回归保持 GREEN。

## GREEN

3. Grok 实现 `resolveChunkRead`，复用 task store 单设备锁与既有 bundle 校验。
4. Grok 实现 `createRestoreChunkReader`：权威 manifest 复核、no-follow open、同 fd 双 fstat、精确范围读取、close/fail-close。
5. 小步运行：

```bash
node --test test/restore-task-store.test.js test/restore-chunk-reader.test.js
node --test test/restore-snapshot-reader.test.js test/restore-service.test.js
```

## 闭环

6. GLM adversarial：重点检查 task/status race、路径逃逸、fd 竞态、错误泄漏、O(fileSize × chunks) 回归。
7. Qwen 统计：文件、哈希、测试数量、protected hashes。
8. fresh Kimi K3：独立源码与真实 fixture 验收；明确 `C6_HOLD` 仅在本 reader PASS 后解除“reader 缺失”这一项，C6 路由本身仍未实现。
9. Codex PM：目标测试、C2/C5 回归、全量测试、`git diff --check`、受保护哈希。

**Exact stage paths:**

- `docs/superpowers/specs/2026-07-23-linke-v142-g0c-c55-chunk-reader-design.md`
- `docs/superpowers/plans/2026-07-23-linke-v142-g0c-c55-chunk-reader.md`
- `src/restore-chunk-reader.js`
- `test/restore-chunk-reader.test.js`
- `src/restore-task-store.js`
- `test/restore-task-store.test.js`

**建议 commit：** `feat: add bounded G0c snapshot chunk reader`

**完成条件：** P0/P1=0、全部验证通过、无 public route diff。完成后才进入 C6 RED。
