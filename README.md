# OpenCode Go 用量广播

这是一个 Cloudflare Worker：在北京时间 09:00 至 23:00 的整点读取 OpenCode Go 用量，并通过 PushPlus 向指定主题发送通知。通知包含三项额度，以及在授权可用时生成的最近 24 小时用量明细、模型排行和签名 SVG 图表。

## 广播内容与顺序

整点广播（手动触发时标题相应变为“手动用量”）的正文按下面顺序输出；各行由 PushPlus 的换行分隔：

1. 5 小时额度（百分比和重置时间）。
2. 每周额度（百分比和重置时间）。
3. 每月额度（百分比和重置时间）。
4. 最近 24 小时明细：请求数、总 Token、四类 Token、费用、模型排行、图表或图表降级说明；若明细不可用，则在这里说明原因和下一步。
5. 观察时间。
6. “当前小时为部分小时，仅统计至观察时间”的口径说明。
7. 事件号。

明细成功时，模型排行显示前五个模型；其余模型合并为“其他”。如果采集在限制内没有完成，数值会以“至少”标识，图表也只代表已经采集到的最新记录。

## 24 小时、Token 与费用口径

- 窗口以北京时间整点对齐，含当前小时在内共 24 个小时桶；当前小时是部分小时，截止于本次观察时间。
- 四类 Token 为输入、输出、推理和缓存。缓存 Token 等于缓存读取、5 分钟缓存写入和 1 小时缓存写入之和；总 Token 为四类 Token 之和。
- 请求数、费用和模型排行只统计窗口内、观察时间之前的记录。费用使用 OpenCode 返回的 `cost`，其单位为微美分（microcents），显示时按 `cost / 100000000` 换算为美元，并保留四位小数。
- D1 不保存逐条用量明细、Cookie 或授权包。图表快照只保存已聚合的 24 个小时桶及观察信息，供对应的 SVG 链接读取；快照在创建 30 天后分批清理。

## 授权、分页与降级

用量明细依赖 `OPENCODE_SESSION_BUNDLE`。授权工具会在临时浏览器配置文件中要求用户完成一次 GitHub 登录，然后依次捕获 `/go` 与 `/usage` 请求；结束后自动关闭浏览器并删除临时配置文件。

- 旧的 V1 会话包没有 `usage.list` 分页授权信息，系统会将 24 小时明细降级为“尚未授权”，但三项额度广播继续发送。
- 如果 V2 会话包只授权了单页，而首次 `/usage` 正好满 50 条，系统不会猜测下一页；会提示“分页尚未授权”，必须重新运行授权工具以捕获分页请求。
- 采集最多读取 40 页，并有 25 秒总时限。达到任一上限会输出已采集记录的截断汇总（带“至少”），而不是阻断本次额度广播。
- 登录失效、暂时网络问题或响应结构变化同样只会让明细降级；`/usage` 的失败不应阻断 `/go` 配额读取、额度消息创建或投递。

重新授权并且只创建新的 Worker 版本时，使用：

```powershell
npm run auth:setup -- --version-only
```

该模式把新会话包写入最新 Worker 版本的 `OPENCODE_SESSION_BUNDLE`，不会移动 preview alias，也不会发布生产版本。完成该命令后，仍须重新执行带 `--preview-alias usage-chart` 的版本上传，才能让预览 alias 指向含新会话包的版本。

## 本地准备与检查

需要 Node.js 22 或更高版本，以及已登录的 Cloudflare 和 GitHub CLI（仅部署或创建 PR 时需要）。安装依赖并运行完整本地检查：

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run check
git diff --check
```

`.dev.vars` 只用于本地开发，绝不提交。不要把生产 Secret、Cookie、完整会话授权包或签名 URL 写入 README、日志、截图、issue、PR 或配置样例。

## 图表配置与访问范围

新增的两个配置项如下：

- `PUBLIC_BASE_URL`：图表公开读取所用的 HTTPS 根地址，只能是 origin，不能带路径、查询参数、用户信息或非标准端口。生产值应是生产 Worker 根地址；预览上传时必须改为预览 alias 根地址。
- `USAGE_CHART_SIGNING_SECRET`：至少 32 个字符的独立 Secret，用 HMAC-SHA-256 为图表快照编号签名。它必须在第一次图表版本上传之前写入 Worker Secret，绝不写入文件或回显。

每条广播生成的图表 URL 是一个带签名的 SVG 链接。Worker 只接受 `GET`、精确路径和签名参数，并拒绝带 Cookie 或 `Authorization` 的请求；因此它不是账户登录页，但任何拿到完整签名链接的人都可在快照保留期内查看该图表。链接只包含聚合图表数据，不含原始记录或会话凭据。预览 alias 必须公开，且不能启用 Cloudflare Access，否则微信客户端无法匿名读取 SVG。

## 严格的预览验收顺序

以下是远程操作说明，必须按顺序执行；本地检查不能替代这些门槛。命令中的 Secret 均通过安全输入或临时变量提供，不能用真实值替换后保存到任何文件。

1. 确认生产根地址为 `https://opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`，预览 alias 根地址为 `https://usage-chart-opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`。后续预览一律使用后者。
2. 先对远程 D1 应用 migration，再安全地创建 `USAGE_CHART_SIGNING_SECRET`；随后运行 `npx wrangler versions upload --dry-run`。`wrangler versions secret put` 只创建新版本，不会移动 preview alias。
3. 第一次上传必须带 `--preview-alias usage-chart`、预览 `PUBLIC_BASE_URL` 和预览标签。确认 alias 对外公开、没有 Cloudflare Access。
4. 在同一 PowerShell 会话运行 `npm run auth:setup -- --version-only`，完成一次 GitHub 登录；工具依次访问 `/go`、`/usage`，捕获完成后关闭并清理临时 profile。两次上传之间暂停 CI 和其他发布。
5. 再次执行 `npx wrangler versions upload --preview-alias usage-chart`，并再次传入预览 `PUBLIC_BASE_URL`，使 alias 移到含新会话包的版本；只核对最新版本 Secret 名称中含有 `OPENCODE_SESSION_BUNDLE` 与 `USAGE_CHART_SIGNING_SECRET`，不要读取或打印 Secret 值。
6. 仅向预览 alias 的 `/admin/manual-trigger` 发起一次带安全输入的 `MANUAL_TRIGGER_SECRET` 和唯一幂等键的请求，确认响应为 204。不要用 GitHub 生产工作流替代该验收。
7. 在微信打开本次 PushPlus 详情，确认三项额度、24 小时文字汇总、模型排行和 SVG 都可见。若 SVG 不可见，停止生产发布，保留预览版本并回到设计决策；不要临时接入第三方图表，也不要声称验收通过。
8. 只有上述微信门槛通过后，才推送分支并创建中文、非草稿 PR。PR 只能陈述实际完成的验证；合并后再在主分支运行 `npm run check` 与生产部署，并观察下一个北京时间整点。

## 生产运行说明

生产配置保持 `PUBLIC_BASE_URL` 为生产根地址，Cron 为 `0 1-15 * * *`（UTC），即北京时间每日 09:00 至 23:00。手动触发、定时广播和三项额度仍沿用原有规则；新增明细和图表始终是可降级的附加内容。

本地启动开发服务：

```powershell
npm run dev
```

不要在本地或生产配置中留下真实的 `OPENCODE_SESSION_BUNDLE`、Cookie、图表签名、PushPlus 凭据或任何授权包。
