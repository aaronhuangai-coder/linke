# Linke V0.30 版本覆盖率显示执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Console “备份版本一致性”面板的各任务组中，增加版本覆盖率百分比的显示（例如 `覆盖率 67%`），且当 `expectedDeviceCount` 为 0 时不显示 `覆盖率` 字样。

**Architecture:** 扩展 `src/web/app.js` 中的版本一致性渲染逻辑。在为各任务组创建并拼接 `version-consistency-coverage-gap` 元素时，若预期设备数大于 0，利用 `Math.round` 算得百分比并拼入 ` · 覆盖率 X%` 字符串。否则，保持原格式不拼入 `覆盖率`。

**Tech Stack:** Node.js built-in test runner, plain browser DOM/ESM, vanilla CSS.

## Global Constraints

- 当前版本更新为 V0.30。
- 遵循 TDD 规范，先写 RED 测试与设计/计划文档，再实施生产代码与 README 更新。
- 只修改 V0.30 相关测试、前端只读百分比渲染实现、README 与设计/计划文档。
- 不引入任何写操作、后端 API、或 NAS 连接。

---

### Task 1: RED Tests

**Files:**
- Modify: [test/web-console.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/web-console.test.js)
- Modify: [test/readme.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/readme.test.js)

- [x] **Step 1: 增加 DOM 渲染测试**
  在 `test/web-console.test.js` 中新增 DOM 单元测试，对于 2 / 3 的覆盖率情况，验证 `version-consistency-coverage-gap` 元素 textContent 包含 `覆盖率 67%`；对于 `expectedDeviceCount` 等于 0 的情况，验证元素 textContent 不包含 `覆盖率` 字样。
- [x] **Step 2: 增加 README.md 升级至 V0.30 及其特性的测试断言**
  在 `test/readme.test.js` 中新增/升级断言，要求 README 包含 V0.30 标题、当前版本 V0.30 徽章、里程碑表格中的 V0.30 版本覆盖率显示行、V0.30 特性项、安全文档、Web Console 特性列表和测试覆盖列表更新。
- [x] **Step 3: 运行测试并确认 RED**
  执行 `node --test test/web-console.test.js test/readme.test.js`，确认新增测试全部失败（当前版本中）。

### Task 2: Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `README.md`

- [x] **Step 1: 实现覆盖率百分比的渲染逻辑**
  在 `src/web/app.js` 的 `renderVersionConsistencyRows` 函数中，为 `version-consistency-coverage-gap` 元素计算百分比并插入文本。若 `expectedDeviceCount > 0`，则插入 ` · 覆盖率 X%`；若为 0，则不包含任何 `覆盖率` 文本。
- [x] **Step 2: 更新 README.md 描述**
  将 `README.md` 全面更新至 V0.30，并在版本记录、特性列表、安全边界部分加入对版本一致性覆盖率显示的相关说明。
- [x] **Step 3: 运行测试并确认 GREEN**
  执行 `node --test test/web-console.test.js test/readme.test.js` 并确认所有测试通过。
