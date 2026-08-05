# SolidStart 用量授权实施计划

> **纠偏说明：** 本计划取代 `2026-08-05-usage-details-chart.md` 中关于 `usage.list` 固定端点、原始数组参数、捕获第 0/1 页请求以及 JSON 响应的协议假设；旧计划仅保留为历史实施记录。

> **供执行代理使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项执行带复选框的步骤。

**目标：** 只捕获一次 OpenCode 真实 SolidStart 用量请求，不点击第二页；同时在不动态执行代码的前提下解码其 Seroval 分帧响应。

**架构：** 把初始 `queryUsageInfo(workspaceId, 0)` GET 请求作为唯一授权来源。严格校验不透明服务函数 ID 和 Seroval 参数，规范化 `args` 查询值，并只修改 Seroval 页号节点来派生分页模板。使用受限的 Acorn AST 求值器解码 SolidStart JavaScript 分帧响应，只接受用量记录所需的 Seroval 语法形状。

**技术栈：** TypeScript、Node.js 22、Playwright Core、Acorn、Vitest、Node 测试运行器。

## 全局约束

- 禁止用 `eval`、`Function`、`vm` 或 Seroval 运行时反序列化器执行捕获的 JavaScript。
- 只捕获同源 `https://opencode.ai/_server` GET 请求，且 `id`、`X-Server-Id`、工作区 ID 和页号必须精确匹配。
- 捕获时严格核对原始 `x-server-id` 与 `x-server-instance`，但请求描述符只保留 `accept` 和有请求体时的 `content-type`；Cookie 只写入会话包的独立认证字段，不得混入请求描述符，也不得持久化 `X-Server-*` 或任意其他浏览器请求头。
- 不得点击分页控件，也不得捕获直接分页 POST 请求。
- 注册响应等待器后，必须通过 Solid Router 同源 SPA 导航触发用量请求；用量路由不得使用完整文档 `page.goto`。
- 保留现有 512 KiB 捕获上限，并为解析器设置有限的深度和节点数量上限。

---

### 任务 1：真实请求契约与分页派生

**文件：**

- 修改：`scripts/auth-setup.test-node.ts`
- 修改：`src/opencode-session.ts`
- 修改：`scripts/opencode-usage-capture.ts`

**接口：**

- 产出：`buildUsageGetAuthorization(firstPage, workspaceId, recordCount)`，返回规范化首页描述符以及单页或 URL 页号模板。
- 使用：`validateUsageListRequestDescriptor(request, workspaceId, expectedPage)`。

- [ ] **步骤 1：编写失败测试**

添加 `GET /_server?id=<64 位十六进制>&args=<Seroval JSON>` 用例，并附带匹配的 `x-server-id`、`x-server-instance`。断言错误页号和 `id`/请求头不一致时会跳过；断言最小化后连同 `cookie`、`origin` 和测试请求头一起丢弃两个服务函数请求头。

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`npm run test:auth`

预期：实现前，新 GET 请求被拒绝或新辅助函数不存在。

- [ ] **步骤 3：实现严格校验与规范化**

只解析严格的 Seroval 两元素参数图。会话描述符要求 `GET`、路径 `/_server`、唯一 `id` 和 `args`、64 位小写十六进制 `id`。捕获层在最小化前额外要求原始 `x-server-id === id`，以及符合 `server-fn:<非负整数>` 的原始 `x-server-instance`；最小化时丢弃二者。将参数图重新序列化为第 0 页，克隆为第 1 页，再调用 `deriveUsagePageNumberTemplate` 生成模板。

- [ ] **步骤 4：运行聚焦测试并确认通过**

运行：`npm run test:auth`

预期：所有授权测试通过。

### 任务 2：Seroval 分帧用量响应

**文件：**

- 修改：`package.json`
- 修改：`package-lock.json`
- 新建：`src/solidstart-seroval.ts`
- 修改：`src/opencode-usage.ts`
- 修改：`src/opencode-http.ts`
- 修改：`src/opencode-usage-source.ts`
- 修改：`test/opencode-usage.test.ts`
- 修改：`test/opencode-usage-source.test.ts`

**接口：**

- 产出：`parseSolidStartSerovalStream(input: string | Uint8Array): unknown`。
- 使用：现有 `parseUsageListPage(input, contentType)` 记录校验器；网络与浏览器捕获路径必须优先传入原始 `Uint8Array`。

- [ ] **步骤 1：编写失败响应测试**

添加带 12 字节长度前缀的 `text/javascript` 帧；箭头函数包装器把 `$R[0]` 赋值为包含 `new Date(...)` 的用量记录数组。另加空数组帧和恶意或不受支持语法用例。

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`npm test -- --run test/opencode-usage.test.ts`

预期：分帧 JavaScript 被现有 JSON 解析器拒绝。

- [ ] **步骤 3：实现受限 AST 解码器**

把 Acorn 加为显式依赖。校验每个 12 字节帧头和精确 UTF-8 字节长度，解析完整表达式，并要求唯一箭头函数包装器中恰有一次对 `$R[0]` 的赋值。只求值字面量、数组、普通对象属性、`$R[index]` 赋值或向后引用、`new Date(string)` 以及严格限制的一元负数。拒绝函数调用、getter、计算对象键、展开语法、原型修改键、循环或前向引用、重复容器、超深或超量节点、尾随语法以及无效日期；记录数组搜索使用迭代遍历、`WeakSet` 和固定图访问上限，避免共享引用造成指数展开。把日期转换为 ISO 字符串后交给现有记录校验器。Worker 重放用量请求时，由受控调用选项加入内部生成的 `x-server-instance: server-fn:<页号>`，不得加入 `x-server-id`；服务端通过 URL `id` 路由，并因此返回 JavaScript 分帧响应。

- [ ] **步骤 4：运行聚焦测试并确认通过**

运行：`npm test -- --run test/opencode-usage.test.ts`

预期：合法分帧响应可解析，不安全语法被拒绝。

### 任务 3：单请求 SPA 授权流程

**文件：**

- 修改：`scripts/auth-setup.ts`
- 修改：`scripts/auth-setup.test-node.ts`

**接口：**

- 使用：`waitForUsageListPage(page, workspaceId, 0, signal)` 和 `buildUsageGetAuthorization`。
- 产出：浏览器无需第二页交互即可渲染第 0、1 页的 V2 会话包。

- [ ] **步骤 1：编写失败流程测试**

断言满 50 条的首页会生成分页 URL 模板，且渲染第 0 页等于规范化捕获请求、渲染第 1 页通过语义校验。添加最小假页面测试，证明 `navigateWithinOpenCodeApp(page, url, signal)` 在页面上下文创建并点击同源链接，而不调用 `page.goto`。

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`npm run test:auth`

预期：授权构造器或 SPA 导航辅助函数不存在，旧流程仍依赖完整文档导航和第二页捕获。

- [ ] **步骤 3：移除第二页捕获和用量完整导航**

先注册第 0 页等待器，再用 `page.evaluate` 创建同源 usage 链接、挂载、点击以便 Solid Router 拦截，并移除该链接。直接从第 0 页捕获请求构造 `usageList`：少于 50 条使用 `single-page`，恰好 50 条使用派生 GET 模板。删除 usage 的 `page.goto`、分页控件选择、第二页等待，以及跨 GET/POST 比较方法或请求头的假设。

- [ ] **步骤 4：运行授权与会话测试**

运行：`npm run test:auth`

运行：`npm test -- --run test/opencode-session.test.ts`

预期：两组测试都通过。

### 任务 4：验证与交付

**文件：**

- 修改：`docs/superpowers/specs/2026-08-05-usage-details-chart-design.md`
- 修改：`README.md`
- 修改：`.superpowers/sdd/2026-08-05-usage-details-chart/task-3-report.md`

**接口：**

- 使用：所有实现和测试结果。
- 产出：证据完整的中文提交与父代理报告。

- [ ] **步骤 1：运行完整验证**

运行：`npm run typecheck`

运行：`npm test`

运行：`npm run test:auth`

预期：所有命令退出码均为 0。

- [ ] **步骤 2：复核最终差异**

运行：`git diff --check`

运行：`git diff --stat`

预期：没有空白错误，且只有任务范围内文件发生变化。

- [ ] **步骤 3：记录证据并提交**

更新设计稿中的授权契约：只捕获 SPA 初页 GET、从 Seroval `args` 派生分页、由 Worker 临时生成且不持久化 `X-Server-Instance`、无 `eval` 解析分帧响应；README 补充上游构建函数 ID 变化时需重新运行授权。把协议依据、RED/GREEN 命令和验证输出追加到任务报告。暂存任务范围内文件，并以 `修复 SolidStart 用量授权捕获` 提交。
