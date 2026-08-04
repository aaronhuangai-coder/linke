# Linke V1.46 Controller Auth Scope Parity 实施计划

> 本计划按 TDD 执行。实现者为 Grok；GLM 负责抗辩；Codex 负责 old-HEAD RED、候选验证、全量回归和 Git 边界；Qwen 统计；fresh Grok 与 Kimi 做闭环。

**目标：** 让 `npm start` 的 controller 管理面透传 previous-read、previous-write 与 admin scope，同时保持 Agent listener、status、日志和 Gold 声明不变。

**基准：** `dafc0ff`

**允许代码文件：**

- `src/controller-runtime.js`
- `test/controller-runtime.test.js`

## Task 1：冻结哈希与隔离树

1. 记录允许文件与保护文件 SHA-256。
2. 从 `dafc0ff` 建立无 `.git`、无敏感文件、无未跟踪文件的严格隔离树。
3. 建立 source-side 回滚锚点，但不暂存 `.superpowers/`。
4. 预检隔离树不存在 `.env*`、`secrets/`、`credentials/`、符号链接和 `.git`。

## Task 2：先写最终行为测试并证明 RED

在 `test/controller-runtime.test.js` 增加最小测试组：

1. `parseControllerEnv()` 返回 full/read/previous-read/write/previous-write/admin 六类字段，且 full token 保持 `LINKE_AUTH_TOKEN` 优先。
2. 空 admin/previous 环境值保持兼容，不激活无可满足的范围。
3. `startController()` 的 management factory 收到六类字段原值；Agent factory options 对所有 management token 字段执行 `hasOwnProperty === false`。
4. `runtime.status` 与成功/失败日志不包含 sentinel。
5. 通过默认 management factory 的真实 controller HTTP listener 验证：
   - admin 配置时 current/previous write 对 enrollment/revoke 均为 403；
   - admin 对 enrollment 为 201、revoke 为 200；
   - admin 缺省时 current/previous write 对两路由成功。
6. previous-only 配置触发 management 创建失败后，Agent listener 已关闭；同一端口可以立即重新绑定；错误与日志不含 sentinel。

在旧生产 `dafc0ff` 上运行新增测试，保存行为特定 RED 计数和失败摘要。若只是 setup/import/syntax 失败，不得进入实现。

## Task 3：Grok 最小 GREEN

只修改 `src/controller-runtime.js`：

1. 扩展 `startController()` JSDoc 与解构参数。
2. 在 management factory 独立对象中传递 `previousReadToken`、`previousWriteToken`、`adminToken`。
3. 扩展 `parseControllerEnv()` JSDoc 与返回对象。
4. 一一读取三个新增环境变量；不重构既有 full-token precedence。
5. 不新增校验器，不修改 `server.js`，不把管理令牌传给 Agent listener。

运行新增测试及 controller-runtime focused 回归，直到 GREEN。

## Task 4：Codex 权威验证

1. 对隔离树进行文件 allowlist 与保护哈希检查。
2. 将候选允许文件外科式回收至 source。
3. 在 detached `dafc0ff` 旧生产树复现最终测试 RED。
4. 在 source 运行：
   - 新增 controller scope 测试；
   - `test/controller-runtime.test.js` 全文件；
   - admin/previous token focused 回归；
   - 完整 `node --test test/*.test.js`；
   - `git diff --check`。
5. 检查无真实 Keychain、LaunchAgent、部署、网络外联、邮件或生产写入。

## Task 5：统计、复审与闭环

1. Qwen 核对最终文件数、增删行、新测试数和总测试增量。
2. fresh Grok reviewer 只读检查：
   - 真实 controller 入口而非 direct server 假绿；
   - Agent/management options 对象隔离；
   - previous-only 清理与端口释放；
   - token/status/log 脱敏；
   - Gold 不升级。
3. Kimi closure reviewer 汇总 GLM、Grok、Codex、Qwen 证据。
4. 只有无 P0/P1、测试全绿且 Kimi `CLOSURE_READY: YES`，才进入精确 commit/push。

## Task 6：提交边界

1. 仅暂存规格、计划及两个允许代码文件中实际发生变更的文件。
2. 排除 `.superpowers/`、历史未跟踪文档与 `package-lock.json`。
3. 提交信息使用约定式格式；推送当前 `linke-v0.12-web-panel` 分支。
4. 不创建 PR、不合并、不部署、不声称 Gold/GA。
