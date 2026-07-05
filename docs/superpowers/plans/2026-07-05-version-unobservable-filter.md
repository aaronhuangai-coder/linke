# Linke V0.32 版本一致性无可观测设备筛选执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Console “备份版本一致性”面板的覆盖筛选器中引入一个新的选项值 `unobservable`（无可观测设备筛选），使得当用户选择该选项时，仅返回预期设备数 `expectedDeviceCount <= 0` 的任务组。同时，`gap` 和 `full` 筛选模式应当排除 `expectedDeviceCount <= 0` 的任务组。此外，将 README 测试升级至 V0.32。

**Architecture:**
1. HTML 结构：在 `version-consistency-coverage-filter` 的 `<select>` 元素中添加 `<option value="unobservable">无可观测设备</option>`。
2. 过滤逻辑：修改 `src/web/app.js` 中的 `filterVersionConsistencyGroups` 函数。在进行 coverage 属性过滤时，如果是 `unobservable`，仅保留 `expectedDeviceCount <= 0` 的任务组；如果是 `gap`，不仅要 `missingDeviceCount > 0` 还要 `expectedDeviceCount > 0`；如果是 `full`，不仅要 `missingDeviceCount === 0` 还要 `expectedDeviceCount > 0`。
3. 单元测试与测试套件：在 `test/web-console.test.js` 和 `test/readme.test.js` 中增加/升级对应的测试（本阶段要求为 RED 测试，不可做生产代码修改）。

**Tech Stack:** Node.js built-in test runner, plain browser DOM/ESM, vanilla CSS.

## Global Constraints

- 当前版本更新为 V0.32。
- 遵循 TDD 规范，先写 RED 测试与设计/计划文档，再实施生产代码与 README 更新。
- 只修改 V0.32 相关测试、无可观测设备过滤实现、README 与设计/计划文档。
- 不引入任何写操作、后端 API、或 NAS 连接。

---

### Task 1: RED Tests

**Files:**
- Modify: [test/web-console.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/web-console.test.js)
- Modify: [test/readme.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/readme.test.js)

- [x] **Step 1: 增加 HTML 契约测试与纯函数过滤逻辑测试**
  在 `test/web-console.test.js` 中：
  - 断言 `version-consistency-coverage-filter` 下拉菜单中包含 `value="unobservable"`。
  - 在 `filterVersionConsistencyGroups` 支持 coverage 筛选的测试中，新增 `coverage: 'unobservable'` 过滤测试，断言只返回 `expectedDeviceCount <= 0` 的任务组。
  - 在 `filterVersionConsistencyGroups` 支持 coverage 筛选的 `gap` 和 `full` 断言中，确保它们严格排除了 `expectedDeviceCount <= 0` 的任务组。
  - 增加组合过滤（composes with status/query/sort）和不改动数据源数组的测试，对 `coverage: 'unobservable'` 进行验证。
- [x] **Step 2: 增加 README.md 升级至 V0.32 的测试断言**
  在 `test/readme.test.js` 中：
  - 更新对当前版本的断言，要求为 V0.32。
  - 增加对“版本一致性无可观测设备筛选”说明文字、特性的断言。
- [x] **Step 3: 运行测试并确认 RED**
  执行 `npm test`，确认所有新增/修改的测试均失败（RED 状态），因为尚未修改 `src/web/app.js` 和 `README.md`。

### Task 2: Implementation (Not in this PR/Phase)

**Files:**
- Modify: `src/web/app.js`
- Modify: `README.md`

- [x] **Step 1: 实现无可观测设备过滤及 gap/full 排除过滤 expectedDeviceCount <= 0 的逻辑**
  修改 `src/web/app.js` 的 `filterVersionConsistencyGroups` 和 HTML 下拉菜单渲染，使测试通过。
- [x] **Step 2: 更新 README.md 至 V0.32**
  在 `README.md` 中添加对应特性的更新说明及安全承诺。
- [x] **Step 3: 运行测试并确认 GREEN**
  执行 `npm test` 并确认所有测试通过。
