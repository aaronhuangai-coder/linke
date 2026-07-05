# Linke V0.31 版本一致性无可观测设备回退执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Console “备份版本一致性”面板的各任务组中，当 `expectedDeviceCount <= 0` 时展示 `无可观测设备` 并仍然不显示 `覆盖率`，当 `expectedDeviceCount > 0` 时不展示 `无可观测设备`。同时升级 README 测试到 V0.31。

**Architecture:** 扩展 `src/web/app.js` 中的版本一致性渲染逻辑。在为各任务组创建并拼接 `version-consistency-coverage-gap` 元素时，若预期设备数 `expectedDeviceCount <= 0`，则在渲染的文本中加入 `无可观测设备` 回退文本，且不拼接 ` · 覆盖率 X%` 字符串。若 `expectedDeviceCount > 0`，则正常计算并拼入覆盖率，但不拼接 `无可观测设备`。

**Tech Stack:** Node.js built-in test runner, plain browser DOM/ESM, vanilla CSS.

## Global Constraints

- 当前版本更新为 V0.31。
- 遵循 TDD 规范，先写 RED 测试与设计/计划文档，再实施生产代码与 README 更新。
- 只修改 V0.31 相关测试、前端只读回退渲染实现、README 与设计/计划文档。
- 不引入任何写操作、后端 API、或 NAS 连接。

---

### Task 1: RED Tests

**Files:**
- Modify: [test/web-console.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/web-console.test.js)
- Modify: [test/readme.test.js](file:///Users/ah/linke/.worktrees/linke-v0.12-web-panel/test/readme.test.js)

- [x] **Step 1: 增加/修改 DOM 渲染测试**
  在 `test/web-console.test.js` 中修改/新增 DOM 单元测试。验证当 `expectedDeviceCount <= 0` 时，`version-consistency-coverage-gap` 元素 textContent 包含 `无可观测设备` 且不包含 `覆盖率` 字样；当 `expectedDeviceCount > 0` 时，textContent 包含 `覆盖率` 且绝对不包含 `无可观测设备`。
- [x] **Step 2: 增加/修改 README.md 升级至 V0.31 及其特性的测试断言**
  在 `test/readme.test.js` 中新增/升级断言，要求 README 包含 V0.31 标题、当前版本 V0.31 徽章、里程碑表格中的 V0.31 版本（含无可观测设备回退）、V0.31 特性项、安全文档、Web Console 特性列表和测试覆盖列表更新。
- [x] **Step 3: 运行测试并确认 RED**
  执行 `npm test`，确认新增/修改的测试全部失败（呈 RED 状态），因为尚未更新生产代码和 README.md。

### Task 2: Implementation (Not in this PR/Phase)

**Files:**
- Modify: `src/web/app.js`
- Modify: `README.md`

- [x] **Step 1: 实现无可观测设备回退的渲染逻辑**
  在 `src/web/app.js` 中，当 `expectedDeviceCount <= 0` 时，让 `coverageText` 包含 `无可观测设备` 且不包含 `覆盖率`；当 `expectedDeviceCount > 0` 时，不展示 `无可观测设备`。
- [x] **Step 2: 更新 README.md 描述**
  将 `README.md` 全面更新至 V0.31，并在版本记录、特性列表、安全边界部分加入对无可观测设备回退的相关说明。
- [x] **Step 3: 运行测试并确认 GREEN**
  执行 `npm test` 并确认所有测试通过。
