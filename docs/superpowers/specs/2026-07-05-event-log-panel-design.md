# Linke V0.20 事件日志面板增强设计

## 摘要

V0.20 增强现有 Web Console 事件日志面板。当前控制台已有 `event-log` 容器和 `logEvent()` 调用，但事件只作为非结构化文本追加，缺少可测试的条目结构、计数、最近事件摘要和容量边界。V0.20 将事件日志收敛为前端内存态、只读、结构化的操作轨迹视图。

## 目标

- 在 Web Console 事件日志面板中展示结构化事件条目：时间、类型、消息。
- 增加事件摘要：累计事件数、info 事件数、error 事件数、最近事件。
- 事件列表最新在前。
- 页面生命周期内最多保留 50 条可见事件，超过后裁剪最旧条目。
- 计数语义固定为页面生命周期累计值，不受 50 条可见容量裁剪影响。
- 保留既有事件来源：控制台启动、设备加载成功/失败、快照加载成功/失败、快照清单、恢复预检、备份预检、NAS dry-run、快照差异和保留计划。
- 更新测试和 README，使 V0.20 成为当前版本。

## 非目标

- 不新增后端 API。
- 不持久化事件日志。
- 不读取或写入 metadata。
- 不连接 NAS，不调用 NAS app。
- 不触发真实备份、恢复、删除、同步或远程传输。
- 不增加认证/鉴权能力。
- 不把事件日志作为审计合规系统。

## 用户体验

事件日志面板仍位于现有 Web Console 中。面板顶部展示：

- 累计事件数
- info 事件数
- error 事件数
- 最近事件摘要

面板下方展示事件列表。每条事件包含：

- 时间：事件发生时的本地时间字符串
- 类型：`info` 或 `error`
- 消息：人类可读的事件内容

空状态显示“暂无事件”。控制台初始化后会立即记录“Linke 控制台已启动”，所以正常运行时不会长期保持空状态。

## DOM 合约

HTML 需要新增稳定 hook：

- `data-testid="event-log-panel"`
- `data-testid="event-total-count"`
- `data-testid="event-info-count"`
- `data-testid="event-error-count"`
- `data-testid="event-latest-message"`
- `data-testid="event-log"`
- `data-testid="event-log-safety-note"`

每条事件由 `app.js` 动态创建，并使用：

- `data-testid="event-entry"`
- `data-event-type="<info|error>"`
- 子元素 `data-testid="event-entry-time"`
- 子元素 `data-testid="event-entry-type"`
- 子元素 `data-testid="event-entry-message"`

测试可以依赖 `data-testid` 和 `data-event-type`，不应依赖完整 className 文案。

## 安全边界

事件消息可能包含后端错误文本，例如 HTTP 错误或 JSON error body。V0.20 必须继续用 `createElement` + `textContent` 构造事件条目，不得用 `innerHTML` 拼接事件时间、类型或消息。

事件日志只保存在浏览器当前页面内存中，刷新后丢失。它不写入 `device.json`、`snapshots.json`、`manifest.json` 或任何后端文件。

## 正常态定义

完成后，访问 Web Console 时：

- HTML 包含事件日志面板摘要 hook 和安全说明。
- `initConsole()` 启动后调用 `logEvent('Linke 控制台已启动', 'info')`。
- 成功加载设备后，info 计数增加，事件列表最新在前。
- 加载失败时，error 计数增加，错误消息以文本形式显示。
- 可见事件数量不超过 50。
- README 当前版本为 V0.20，并说明事件日志增强仍是只读前端内存态视图。

## 恢复锚点

事件日志没有持久化状态。异常后恢复锚点是当前页面内存态：

- 单条事件渲染失败不应影响其他面板的后端数据。
- 刷新页面后事件日志从空状态重新开始。
- 若事件 DOM 容器不存在，`logEvent()` 应安全返回，不影响其他控制台逻辑。

## 运行韧性

### 有界失效

- `eventLogEl` 缺失：`logEvent()` 直接返回，不抛异常。
- 事件类型未知：归一化为 `info`，避免产生无法统计的类别。
- 事件过多：保留最新 50 条可见条目，裁剪最旧条目。
- 消息包含 HTML：使用 `textContent`，按文本显示。

### 异常恢复

- 事件日志不依赖后端和本地文件，因此失败不会污染数据。
- 页面刷新即可回到初始事件状态。
- 事件计数只在当前页面生命周期内累计，不跨刷新恢复。

### 状态侦测与自检

- 测试断言计数 hook、事件条目 hook、可见条目上限和错误消息文本渲染。
- HTTP smoke 断言 `/` 与 `/app.js` 包含 V0.20 事件日志增强信号。
- 全量 `npm test` 作为回归门。

## 测试要求

- `test/web-console.test.js`
  - HTML 包含 V0.20 事件日志面板 hook。
  - 事件日志面板无执行按钮，不含备份、恢复、NAS 调用按钮。
  - `initConsole()` 启动后渲染结构化 info 事件。
  - 设备加载成功记录 info 事件。
  - 设备加载失败记录 error 事件，并用文本展示错误消息。
  - 多次事件最新在前。
  - 超过 50 条后只保留最新 50 条可见事件。
  - 消息中的 HTML 不通过 `innerHTML` 注入。
- `test/readme.test.js`
  - README 标题、版本徽章、版本表升级到 V0.20。
  - README 说明事件日志增强是前端只读内存态，不新增 API、不写 metadata、不连接 NAS、不执行备份/恢复。
  - 测试覆盖摘要包含事件日志面板增强。

## 验收命令

```bash
node --test test/web-console.test.js
node --test test/readme.test.js
npm test
git diff --check
```

HTTP smoke：

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v020-smoke node src/server.js
```

然后请求：

```bash
GET /
GET /app.js
GET /api/devices
```

预期：

- HTML 包含 `event-log-panel`、`event-total-count` 和 `event-log-safety-note`。
- `app.js` 包含 `EVENT_LOG_VISIBLE_LIMIT`、`event-entry-message` 和 `data-event-type`。
- `/api/devices` 返回 JSON 数组。

## 完成标准

- V0.20 事件日志增强功能实现并通过测试。
- 不新增后端写入路径。
- 不新增 NAS、备份、恢复执行能力。
- README 与测试同步到 V0.20。
- Codex PM 独立验证全量测试、diff check 和 HTTP smoke。
