# Linke V0.23 版本一致性 snapshot 联动执行计划

## 完成标准

- 版本一致性设备版本行可点击。
- 点击后切换到对应设备上下文。
- 复用现有 snapshot manifest detail 和 restore-dry-run 读取流程。
- 刷新对应设备 snapshots 与 retention dry-run。
- 不新增后端 API，不写 metadata，不执行同步、恢复、删除、NAS 连接或远程传输。
- README 当前版本更新到 V0.23。

## Task 1: RED Tests

- 在 `test/web-console.test.js` 增加源码契约测试：
  - 存在 `selectVersionConsistencySnapshot` click path。
  - 版本设备行包含 `data-snapshot-id`。
  - click path 复用 `fetchSnapshotManifest` 和 `fetchRestoreDryRunPlan`。
- 在 `test/web-console.test.js` 增加 DOM 行为测试：
  - 点击 `version-consistency-device` 后加载对应设备 snapshots、retention dry-run、manifest 和 restore-dry-run。
  - 设备详情切到被点击设备。
- 在 `test/readme.test.js` 增加 V0.23 文档断言。

## Task 2: Implementation

- 为版本一致性设备行增加：
  - `data-device-id`
  - `data-snapshot-id`
  - `data-version-state`
  - click handler
- 新增 `selectVersionConsistencySnapshot(deviceId, snapshotId)`：
  - 设置当前设备和当前 snapshot。
  - 渲染设备详情和设备列表选中态。
  - 调用现有 snapshots、retention、manifest、restore-dry-run 加载函数。

## Task 3: Docs

- README 标题和版本 badge 更新为 V0.23。
- 版本表增加 V0.23，V0.22 改为历史里程碑。
- 新增 “Web Console 版本一致性 snapshot 联动” 章节。
- 新增 “版本一致性 snapshot 联动安全保证”。

## Final Verification

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

HTTP smoke:

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v023-smoke node src/server.js
node --input-type=module -e "const base='http://127.0.0.1:3006'; const html=await (await fetch(base+'/')).text(); const js=await (await fetch(base+'/app.js')).text(); const devices=await (await fetch(base+'/api/devices')).json(); const ok={html:html.includes('data-testid=\"version-consistency-panel\"'), js:js.includes('selectVersionConsistencySnapshot')&&js.includes('data-snapshot-id'), devices:Array.isArray(devices)}; if(!ok.html||!ok.js||!ok.devices){console.error(JSON.stringify(ok)); process.exit(1);} console.log(JSON.stringify(ok));"
```
