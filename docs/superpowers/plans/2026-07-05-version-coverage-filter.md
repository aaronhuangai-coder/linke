# Linke V0.28 版本一致性覆盖筛选执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Console “备份版本一致性”面板的筛选工具栏中，新增一个只读覆盖筛选下拉框，支持在内存中按 `all`、`gap`、`full` 过滤任务组，并与现有筛选/排序组合，不触发快照重新拉取。

**Architecture:** 扩展纯函数 `filterVersionConsistencyGroups` 以处理 `controls.coverage`。在 `initConsole` 中获取该 select 元素并绑定 change 事件，切换时调用内存过滤并刷新 DOM。

**Tech Stack:** Node.js built-in test runner, plain browser DOM/ESM, vanilla CSS.

## Global Constraints

- 当前版本更新为 V0.28。
- 遵循 TDD 规范，先写 RED 测试与设计/计划文档，再实施生产代码与 README 更新。
- 不添加 `loading-failure-only` 过滤。
- 不引入任何写操作、后端 API、或 NAS 连接。

---

### Task 1: RED Tests

**Files:**
- Modify: [test/web-console.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/web-console.test.js)
- Modify: [test/readme.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/readme.test.js)

- [x] **Step 1: 增加 HTML 结构测试**
  断言 HTML 中包含 `data-testid="version-consistency-coverage-filter"` 下拉框，且选项值包含且仅包含 `all`、`gap`、`full`。
- [x] **Step 2: 增加纯函数过滤测试**
  断言 `filterVersionConsistencyGroups` 支持 `coverage` 过滤条件，且能与 status/query/sort 完美组合、不修改原数组顺序。
- [x] **Step 3: 增加 DOM 交互与无 refetch 测试**
  在 Mock DOM 测试中，模拟修改覆盖率筛选下拉框的值并触发 change 事件，校验 DOM 列表的过滤结果以及网络请求次数（确保没有 refetch 发生）。
- [x] **Step 4: 增加 README.md 升级至 V0.28 的测试断言**
  在 `test/readme.test.js` 中新增或升级断言，要求 README 包含 V0.28 标题、V0.28 版本徽章、里程碑表格中的 V0.28 行、V0.28 版本一致性覆盖筛选特性项、安全文档、Web Console 特性列表和测试覆盖列表更新。
- [x] **Step 5: 运行测试并确认 RED**
  执行 `node --test test/web-console.test.js test/readme.test.js`，确认新增和修改后的测试全部由于缺少生产代码和未修改 README 而失败（RED）。

### Task 2: Implementation

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `README.md`

- [x] **Step 1: 在 HTML 中添加 select 控件**
  在版本一致性面板的工具栏中添加 `data-testid="version-consistency-coverage-filter"` 下拉框。
- [x] **Step 2: 升级 filterVersionConsistencyGroups**
  在纯函数中支持 `controls.coverage` 的 `all`、`gap`、`full` 判断。
- [x] **Step 3: 升级 initConsole 控件绑定**
  绑定控件的 change/input 事件，支持内存联动过滤。
- [x] **Step 4: 更新 README.md**
  将 `README.md` 正文升级为 V0.28 并按要求补充说明。

## Final Verification Commands

```bash
node --test test/web-console.test.js test/readme.test.js
```
