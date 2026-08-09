# OpenCode Go 用量广播

这是一个 Cloudflare Worker：在北京时间 09:00 至 23:00 的整点读取 OpenCode Go 用量，并通过 PushPlus 向指定主题发送通知。通知包含三项额度，以及在授权可用时生成的不依赖图片或外部资源的纯 HTML 用量仪表盘。

## 广播内容与顺序

整点广播（手动触发时标题相应变为“手动用量”）的正文是单个纯 HTML 仪表盘，按以下六个区域组织：

1. 状态与观察时间。
2. 三个额度进度条（5 小时、每周和每月额度，均带重置时间）。
3. 三个汇总（最近 24 小时请求数、总 Token 和费用）。
4. 24 小时趋势与四类 Token（输入、输出、推理和缓存）。
5. 完整的 24 小时精确值。
6. 模型排行与元信息（观察时间、当前小时口径和事件号）。

明细成功时，模型排行显示前五个模型，其余模型合并为“其他”。正文安全预算为 18,000 字符；超过预算时会使用兼容版，它会移除装饰性趋势元素，但不会删除完整的 24 小时精确数据。如果采集在限制内没有完成，数值会以“至少”标识，仪表盘也只代表已经采集到的最新记录。明细不可用时，三个额度仍会显示，仪表盘会说明原因和下一步。

## 24 小时、Token 与费用口径

- 窗口以北京时间整点对齐，含当前小时在内共 24 个小时桶；当前小时是部分小时，截止于本次观察时间。
- 四类 Token 为输入、输出、推理和缓存。缓存 Token 等于缓存读取、5 分钟缓存写入和 1 小时缓存写入之和；总 Token 为四类 Token 之和。
- 请求数、费用和模型排行只统计窗口内、观察时间之前的记录。费用使用 OpenCode 返回的 `cost`，其单位为微美分（microcents），显示时按 `cost / 100000000` 换算为美元，并保留四位小数。
- D1 不保存逐条用量明细、Cookie 或授权包。已发送旧消息的历史图表快照只保存已聚合的 24 个小时桶及观察信息，供对应的 SVG 链接读取；快照在创建 30 天后分批清理。新广播不再创建这类快照。

## 授权、分页与降级

用量明细依赖 `OPENCODE_SESSION_BUNDLE`。默认授权流程会在临时浏览器配置文件中要求用户完成一次 GitHub 登录，先从新建空白页捕获 `/go`，再通过站内导航进入 `/workspace/<工作区>/usage`，捕获页面发出的首个只读用量请求；结束后自动关闭浏览器并删除临时配置文件。

可通过 `--profile` 使用一个专用的持久浏览器资料目录。首次使用的新目录或缺少 OpenCode 登录 Cookie 的旧目录会打开登录页，要求完成一次 GitHub 登录并进入工作区；工具会等到新的登录 Cookie 出现后再继续，结束后保留该目录。以后使用同一目录时，只要 OpenCode 登录状态仍有效，工具就会直接复用而不再打开登录页。工具始终不会删除调用方提供的目录；它会优先使用 `--workspace` 指定的工作区，否则只从恢复出的现有工作区页面识别。该目录可能包含 GitHub 和 OpenCode 登录 Cookie，应只保存在当前用户可访问的位置，不得提交、共享或写入日志。

- 旧的 V1 会话包没有 `usage.list` 分页授权信息，系统会将 24 小时明细降级为“尚未授权”，但三项额度广播继续发送。
- 如果 V2 会话包只授权了单页，而后续首次 `/usage` 正好满 50 条，系统不会把前 50 条冒充完整数据；会提示“分页尚未授权”，必须重新运行授权工具刷新授权包。
- 采集最多读取 40 页，并有 25 秒总时限。达到任一上限会输出已采集记录的截断汇总（带“至少”），而不是阻断本次额度广播。
- 登录失效、暂时网络问题或响应结构变化同样只会让明细降级；`/usage` 的失败不应阻断 `/go` 配额读取、额度消息创建或投递。
- OpenCode 的服务函数编号来自当前网站构建，不是固定的 `usage.list` 字符串。上游重新构建后若编号变化，需重新运行授权工具；工具不会保存 GitHub 密码，也不会持久化浏览器的 `X-Server-*` 请求头。

重新授权并且只创建新的 Worker 版本时，使用：

```powershell
npm run auth:setup -- --version-only
```

首次创建或以后复用持久登录资料时，使用：

```powershell
npm run auth:setup -- --profile "C:\安全位置\opencode-browser-profile" --workspace "wrk_Abc123" --version-only
```

请把示例中的 `wrk_Abc123` 替换为真实工作区 ID；该参数仅接受 `wrk_` 加字母或数字。首次创建该目录时仍需在打开的浏览器中登录一次并进入任一工作区。如果资料恢复后只有一个工作区，可以省略 `--workspace`；已有登录状态但无法识别工作区或同时识别出多个工作区时，工具会立即停止并提示补充参数。

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

## 历史图表兼容配置与访问范围

以下两个保留配置只用于已发送旧消息的签名 SVG 图表；新广播不生成图片或新的 SVG 链接。当前 Worker 仍需保留有效配置，以便历史链接在 30 天保留期内可访问，暂时不能删除。

- `PUBLIC_BASE_URL`：历史图表公开读取所用的 HTTPS 根地址，只能是 origin，不能带路径、查询参数、用户信息或非标准端口。生产值应是生产 Worker 根地址；预览上传时必须改为预览 alias 根地址。
- `USAGE_CHART_SIGNING_SECRET`：至少 32 个字符的独立 Secret，用 HMAC-SHA-256 为历史图表快照编号签名。它必须在第一次图表版本上传之前写入 Worker Secret，绝不写入文件或回显。

已发送旧消息中的图表 URL 是带签名的 SVG 链接。Worker 只接受 `GET`、精确路径和签名参数，并拒绝带 Cookie 或 `Authorization` 的请求；因此它不是账户登录页，但任何拿到完整签名链接的人都可在快照保留期内查看该图表。链接只包含聚合图表数据，不含原始记录或会话凭据。预览 alias 必须公开，且不能启用 Cloudflare Access，否则微信客户端无法匿名读取这些历史 SVG。

## 严格的预览验收顺序

以下是远程操作说明，必须按顺序执行；本地检查不能替代这些门槛。命令中的 Secret 均通过安全输入或临时变量提供，不能用真实值替换后保存到任何文件。

1. 确认生产根地址为 `https://opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`，预览 alias 根地址为 `https://usage-chart-opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`。后续预览一律使用后者。
2. 先对远程 D1 应用 migration，再安全地创建 `USAGE_CHART_SIGNING_SECRET`；随后运行 `npx wrangler versions upload --dry-run`。`wrangler versions secret put` 只创建新版本，不会移动 preview alias。
3. 第一次上传必须带 `--preview-alias usage-chart`、预览 `PUBLIC_BASE_URL` 和预览标签。确认 alias 对外公开、没有 Cloudflare Access。
4. 在同一 PowerShell 会话运行 `npm run auth:setup -- --version-only`，完成一次 GitHub 登录；若希望保存并在以后复用登录状态，则改用上面的 `--profile` 命令。工具从新建空白页访问 `/workspace/<工作区>/go`，再通过站内导航进入 `/workspace/<工作区>/usage`。默认临时 profile 会被清理，调用方提供的 profile 会保留。两次上传之间暂停 CI 和其他发布。
5. 再次执行 `npx wrangler versions upload --preview-alias usage-chart`，并再次传入预览 `PUBLIC_BASE_URL`，使 alias 移到含新会话包的版本；只核对最终 alias 版本的 Secret 名称完整包含 `PUSHPLUS_TOKEN`、`PUSHPLUS_TOPIC`、`PUSHPLUS_CALLBACK_SECRET`、`PUSHPLUS_CALLBACK_BASE_URL`、`MANUAL_TRIGGER_SECRET`、`OPENCODE_SESSION_BUNDLE` 与 `USAGE_CHART_SIGNING_SECRET`，不要读取或打印 Secret 值。
6. 仅向预览 alias 的 `/admin/manual-trigger` 发起一次带安全输入的 `MANUAL_TRIGGER_SECRET` 和唯一幂等键的请求，确认响应为 204。不要用 GitHub 生产工作流替代该验收。
7. 远程预览阶段只验证 Worker 行为，不触发真实 PushPlus 广播，也不声称微信端验收已完成；PushPlus 详情页和微信打开页的真实烟测必须等待 PR 合并后的部署阶段。
8. 上述远程预览检查通过后才可推送分支并创建中文、非草稿 PR。PR 只能陈述实际完成的验证；合并后再在主分支运行 `npm run check`、配置生产 Secret、部署并执行真实烟测。

## 生产运行说明

生产配置保持 `PUBLIC_BASE_URL` 为生产根地址，Cron 为 `0 1-15 * * *`（UTC），即北京时间每日 09:00 至 23:00。手动触发、定时广播和三项额度仍沿用原有规则；纯 HTML 仪表盘始终是可降级的附加内容，不影响三项额度或既有时段。


本地启动开发服务：

```powershell
npm run dev
```

不要在本地或生产配置中留下真实的 `OPENCODE_SESSION_BUNDLE`、Cookie、图表签名、PushPlus 凭据或任何授权包。
