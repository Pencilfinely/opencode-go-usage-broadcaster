# OpenCode 会话用量采集实施计划

> **供代理执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务实施。本计划使用复选框跟踪进度。

**目标：** 增加一次性本机授权工具和 Cloudflare Worker 真实用量采集器，将 OpenCode Go 三个用量窗口安全广播给订阅者。

**架构：** 授权工具在临时浏览器中捕获 OpenCode 自身的会话与内部请求描述，独立重放验证后经标准输入上传为单个 Cloudflare Secret。Worker 严格限制请求来源并把响应规范化为现有 `QuotaSnapshot`，其余 D1、规则和 PushPlus 流程保持不变。

**技术栈：** TypeScript、Cloudflare Workers/D1、Wrangler、Playwright Core、Vitest。

## 全局约束

- 所有新增文档、代码注释、提交和 PR 文案使用中文。
- 不保存 GitHub 密码、GitHub 会话、验证码或访问令牌。
- OpenCode 会话只通过标准输入进入 Cloudflare Secret，不写文件、D1、日志或命令参数。
- 真实请求只允许 `https://opencode.ai`，默认仍使用夹具来源。
- 只执行与关键成功、认证、格式、安全和轮换有关的精简测试。

---

### Task 1：会话包与真实采集器

**文件：**
- 新建：`src/opencode-session.ts`
- 修改：`src/domain.ts`
- 修改：`src/config.ts`
- 修改：`src/source.ts`
- 修改：`src/app.ts`
- 测试：`test/opencode-session.test.ts`
- 修改：`test/config-source.test.ts`

**接口：**
- 产出：`OpenCodeSessionBundleV1`、`parseSessionBundle(raw)`、`readBundleGeneration(raw)`、`OpenCodeConsoleQuotaSource`。
- `OpenCodeConsoleQuotaSource.fetch(now)` 返回来源为 `opencode-console` 的 `QuotaSnapshot`。

- [ ] 先写一个测试文件，覆盖合法三窗口响应、登录失效、字段缺失和越权 URL 四条路径。
- [ ] 运行 `npx vitest run test/opencode-session.test.ts`，确认因实现缺失而失败。
- [ ] 实现会话包校验、固定来源请求、超时/体积限制、错误分类和三窗口规范化。
- [ ] 扩展配置、来源工厂和快照校验，使真实来源使用会话包代次并保留显式启用开关。
- [ ] 运行 `npx vitest run test/opencode-session.test.ts test/config-source.test.ts test/app.test.ts`，确认关键回归通过。

### Task 2：一次性本机授权工具

**文件：**
- 新建：`scripts/auth-setup.ts`
- 修改：`package.json`
- 修改：`package-lock.json`

**接口：**
- 消费：任务一的 `OpenCodeSessionBundleV1`、请求安全校验和响应规范化函数。
- 产出：`npm run auth:setup`。

- [ ] 添加 `playwright-core` 与 `tsx`，并注册 `auth:setup` 命令。
- [ ] 实现 Chrome/Edge 临时资料目录、人工登录、同源响应识别以及仅提取 OpenCode `auth` Cookie。
- [ ] 生成随机会话代次，使用独立 `fetch` 重放并输出三个非敏感百分比。
- [ ] 通过子进程标准输入执行 `wrangler secret put OPENCODE_SESSION_BUNDLE`，在 `finally` 中关闭浏览器并删除临时目录。
- [ ] 运行 `npm run typecheck`，确认脚本与 Worker 类型检查通过。

### Task 3：配置说明与交付

**文件：**
- 修改：`wrangler.jsonc`
- 修改：`.dev.vars.example`
- 修改：`README.md`

**接口：**
- 产出：中文部署、授权、轮换、故障和回退说明。

- [ ] 把会话 Secret 加入部署要求，并说明夹具与真实来源的切换方式。
- [ ] 将 README 更新为中文，明确一次性人工登录、会话保存位置和过期后重跑命令。
- [ ] 运行 `npm run check`，只执行现有测试集与新增关键测试。
- [ ] 扫描仓库，确认没有真实凭据、英文新增注释或占位标记。
- [ ] 使用中文提交变更、推送分支并创建中文 PR。
