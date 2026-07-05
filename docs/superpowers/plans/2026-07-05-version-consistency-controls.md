# Linke V0.24 版本一致性筛选与搜索执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Web Console 版本一致性面板增加只读筛选与搜索工具栏。

**Architecture:** 继续复用现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 数据。后端不变，前端保存最近一次 `buildBackupVersionConsistency()` 结果，并在输入变化时过滤内存结果后重渲染列表。

**Tech Stack:** Node.js 内置测试、浏览器 ESM、原生 DOM、无新增依赖。

## Global Constraints

- 当前版本更新为 V0.24。
- 不新增后端 API。
- 不写 metadata。
- 不触发备份、同步、恢复、删除、NAS 连接、NAS app 调用或远程文件传输。
- 动态文本继续使用 `textContent`。
- 按 TDD 执行：先写失败测试，再实现。

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `initConsole(doc, fetchImpl, intervalImpl)`
- Produces: V0.24 HTML hook、DOM 行为、README 断言

- [ ] **Step 1: 写失败测试**

在 `test/web-console.test.js` 增加：

```js
it('HTML contains V0.24 version consistency filter controls', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();

  assert.ok(html.includes('data-testid="version-consistency-search"'));
  assert.ok(html.includes('data-testid="version-consistency-status-filter"'));
  assert.ok(html.includes('data-testid="version-consistency-filter-count"'));
});
```

再增加 DOM 行为测试：设置搜索输入和状态筛选后触发 `input` / `change` listener，断言只渲染匹配任务组，且无匹配时显示占位文案。

在 `test/readme.test.js` 增加 V0.24 当前版本和只读安全边界断言。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/web-console.test.js test/readme.test.js`

Expected: FAIL，缺少 V0.24 hook 或 README V0.24 文案。

### Task 2: Frontend Implementation

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `buildBackupVersionConsistency(devices, snapshotsByDevice)`
- Produces: `versionConsistencyResult` 内存缓存、筛选控件事件、过滤后列表渲染

- [ ] **Step 1: 加 HTML 控件**

在版本一致性 summary 与 list 之间加入搜索框、状态筛选和计数。

- [ ] **Step 2: 加前端状态与过滤函数**

在 `initConsole()` 中读取新 DOM 元素，保存最近一次全量一致性结果，新增：

```js
function getVersionConsistencyControls() {
  return {
    query: versionConsistencySearchInput?.value || '',
    status: versionConsistencyStatusFilter?.value || 'all',
  };
}
```

过滤函数按状态和搜索文本匹配任务组及其设备行。

- [ ] **Step 3: 改渲染路径**

`renderBackupVersionConsistency()` 生成全量结果后缓存，调用过滤渲染函数。搜索和状态变化只重渲染缓存结果，不重新请求 API。

- [ ] **Step 4: 加样式**

复用设备控制区的紧凑表单风格，保证移动端不溢出。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/web-console.test.js test/readme.test.js`

Expected: PASS。

### Task 3: Docs

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: V0.24 行为和安全边界
- Produces: V0.24 用户文档

- [ ] **Step 1: 更新 README**

更新标题、当前版本、版本表和特性列表，新增“Web Console 版本一致性筛选与搜索”章节。

- [ ] **Step 2: 文档安全断言**

说明 V0.24 仍不新增 API、不写 metadata、不触发备份、不执行同步/恢复/删除/NAS 操作。

## Final Verification

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

HTTP smoke:

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v024-smoke node src/server.js
node --input-type=module -e "const base='http://127.0.0.1:3006'; const html=await (await fetch(base+'/')).text(); const js=await (await fetch(base+'/app.js')).text(); const devices=await (await fetch(base+'/api/devices')).json(); const ok={html:html.includes('data-testid=\"version-consistency-search\"')&&html.includes('data-testid=\"version-consistency-status-filter\"'), js:js.includes('versionConsistencyFilterCountEl')&&js.includes('filterVersionConsistencyGroups'), devices:Array.isArray(devices)}; if(!ok.html||!ok.js||!ok.devices){console.error(JSON.stringify(ok)); process.exit(1);} console.log(JSON.stringify(ok));"
```
