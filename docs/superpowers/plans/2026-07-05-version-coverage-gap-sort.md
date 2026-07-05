# Linke V0.29 版本一致性覆盖缺口排序执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Console “备份版本一致性”面板的排序工具栏中，新增一个 `coverage-gap` 排序选项，支持在内存中对已加载的任务组执行基于覆盖缺口指标的级联降序排序，并与现有筛选完美组合，不触发快照重新拉取。

**Architecture:** 扩展纯函数 `filterVersionConsistencyGroups` 以支持 `controls.sort === 'coverage-gap'`。排序链逻辑优先按缺失设备数降序，其次按缺失率（缺失设备数/期望设备数，期望设备数 <=0 时为 0）降序，接着按期望设备数降序，最后以风险排序（compareVersionConsistencyRisk）兜底。在 `initConsole` 中处理该排序切换事件，调用内存重新排序并刷新 DOM。

**Tech Stack:** Node.js built-in test runner, plain browser DOM/ESM, vanilla CSS.

## Global Constraints

- 当前版本更新为 V0.29。
- 遵循 TDD 规范，先写 RED 测试与设计/计划文档，再实施生产代码与 README 更新。
- 只修改 V0.29 相关测试、前端只读排序实现、README 与设计/计划文档。
- 不引入任何写操作、后端 API、或 NAS 连接。

---

### Task 1: RED Tests

**Files:**
- Modify: [test/web-console.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/web-console.test.js)
- Modify: [test/readme.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/readme.test.js)

- [x] **Step 1: 增加 HTML 结构测试**
  断言 HTML 中包含 `data-testid="version-consistency-sort"` 下拉框，且选项值包含既有选项以及新增的 `coverage-gap`。
- [x] **Step 2: 增加纯函数排序测试**
  编写测试，定义具有不同缺失数、期望数、缺失率、状态、最新备份时间的测试组，断言在选择 `coverage-gap` 时返回正确的排序结果。
- [x] **Step 3: 增加组合筛选与原始数据不突变测试**
  断言 `coverage-gap` 与 status/query/coverage 组合过滤时的排序正确，且操作后不改变输入参数 groups 数组的原始顺序。
- [x] **Step 4: 增加 DOM 交互与无 refetch 测试**
  在 Mock DOM 测试中，模拟选择排序下拉框的值为 `coverage-gap` 并触发 change 事件，校验 DOM 列表被重新排序且未发送任何网络请求（没有 refetch）。
- [x] **Step 5: 增加 README.md 升级至 V0.29 的测试断言**
  在 `test/readme.test.js` 中新增/升级断言，要求 README 包含 V0.29 标题、当前版本 V0.29 徽章、里程碑表格中的 V0.29 覆盖缺口排序行、V0.29 特性项、安全文档、Web Console 特性列表和测试覆盖列表更新。
- [x] **Step 6: 运行测试并确认 RED**
  执行 `node --test test/web-console.test.js test/readme.test.js`，确认新增测试全部失败。

### Task 2: Implementation

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `README.md`

- [x] **Step 1: 在 HTML 中添加 coverage-gap 排序选项**
  在 `src/web/index.html` 的排序下拉框中新增 `<option value="coverage-gap">覆盖缺口排序</option>`。
- [x] **Step 2: 实现排序链逻辑**
  在 `src/web/app.js` 的 `compareVersionConsistencyGroups` 函数或新增比较函数中实现级联排序逻辑。
- [x] **Step 3: 绑定和处理 DOM 切换事件**
  在 `src/web/app.js` 的 `initConsole` 中，确保对排序 select 的 change 事件做出反应，触发内存排序与重新渲染。
- [x] **Step 4: 更新 README.md 描述**
  将 `README.md` 全面更新至 V0.29，并在版本记录与安全边界部分加入对覆盖缺口排序的相关说明。

## Final Verification Commands

```bash
node --test test/web-console.test.js test/readme.test.js
```
