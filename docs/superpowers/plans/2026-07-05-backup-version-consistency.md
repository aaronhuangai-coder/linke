# Linke V0.22 备份版本一致性面板执行计划

## 完成标准

- Web Console 新增“备份版本一致性”只读面板。
- 前端复用现有 `/api/devices` 和 `/api/devices/:deviceId/snapshots`。
- 不新增后端路由，不写入 metadata，不执行同步、恢复、删除、NAS 连接或远程传输。
- 测试覆盖纯函数、HTML 契约、DOM 渲染和 README 文档。

## Task 1: 纯函数和规则测试

- 新增 `buildBackupVersionConsistency(devices, snapshotsByDevice)`。
- 输入异常时返回空 summary 和空 groups。
- 按 jobName/sourcePath 分组。
- 每台设备每个任务只取最新 snapshot。
- 分类为 `synced`、`drifted`、`single-device`。

验证：

```bash
node --test test/web-console.test.js
```

## Task 2: Web Console 面板

- 新增 HTML panel：
  - `version-consistency-panel`
  - `version-consistency-synced-count`
  - `version-consistency-drifted-count`
  - `version-consistency-single-count`
  - `version-consistency-total-count`
  - `version-consistency-list`
  - `version-consistency-safety-note`
- `initConsole()` 在设备加载后只读请求每台设备 snapshots。
- 渲染任务组列表和设备版本状态。
- 动态字段使用 `textContent`。

验证：

```bash
node --test test/web-console.test.js
```

## Task 3: README 和安全说明

- README 当前版本更新为 V0.22。
- 版本表增加 V0.22，V0.21 改为历史里程碑。
- 新增 V0.22 行为章节和安全保证。
- 测试覆盖句增加“备份版本一致性面板”。

验证：

```bash
node --test test/readme.test.js
```

## Final Verification

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

临时 HTTP 冒烟：

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v022-smoke node src/server.js
node --input-type=module -e "const base='http://127.0.0.1:3006'; const html=await (await fetch(base+'/')).text(); const js=await (await fetch(base+'/app.js')).text(); const devices=await (await fetch(base+'/api/devices')).json(); const ok={html:html.includes('data-testid=\"version-consistency-panel\"'), js:js.includes('buildBackupVersionConsistency')&&js.includes('version-consistency-item'), devices:Array.isArray(devices)}; if(!ok.html||!ok.js||!ok.devices){console.error(JSON.stringify(ok)); process.exit(1);} console.log(JSON.stringify(ok));"
```
