# OpenCode Go 用量广播器

这是一个 Cloudflare Worker：按计划读取 OpenCode Go 用量，使用 D1 去重和保留状态，并通过 PushPlus 私人主题发送通知。

## 架构与计划

Worker 在北京时间每日 09:00 至 23:00 的每个整点广播当前用量，00:00 至 08:59 保持静默。定时任务从来源读取滚动、周和月三个用量窗口；D1 负责快照版本、任务去重和待投递消息；PushPlus 负责投递及签名回调。PushPlus 接口接受消息后即视为投递成功，不再因回调缺失而重复发送。

默认配置保持 `USAGE_SOURCE=fixture` 与 `OPENCODE_CONSOLE_ENABLED=false`。夹具消息会显示“【测试数据】”，便于避免将演示数据误当成真实数据。

## 前置条件

- Node.js 22 或更高版本。
- Cloudflare 账号，以及已完成的 Wrangler 登录。
- GitHub CLI，以及已完成的仓库登录。
- PushPlus 账号和私人主题。
- 用于 PushPlus 回调的公开 Worker HTTPS 地址。
- 仅当启用真实采集时，需在 PC 上进行一次人工授权，并安装可被 Playwright 调用的 Chrome 或 Edge。

PushPlus 是服务号向私人主题投递消息；它不是在普通个人微信群中发言的机器人。请创建私人主题并仅让预期成员订阅，不要公开其二维码或主题信息。

## 本地检查与夹具演示

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run check
```

示例变量均为不可用占位值。`.dev.vars` 仅供本机使用，不能提交；不要在其中保存 OpenCode 会话。

夹具演示在配置了真实 PushPlus Secret 时会真的投递消息。请先选择私人测试主题，再启动 Worker：

```powershell
npm run dev
```

从另一个 PowerShell 窗口触发整点任务：

```powershell
curl.exe --get --data-urlencode "cron=0 1-15 * * *" --data-urlencode "format=json" "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## 首次部署顺序

以下是操作顺序，不代表这些外部步骤已经完成。

1. 登录 Cloudflare：`npx wrangler login`。
2. 创建并迁移 D1：

   ```powershell
   npx wrangler d1 create opencode-go-usage --binding DB --update-config
   npx wrangler d1 migrations apply opencode-go-usage --remote
   ```

   确认 Wrangler 只替换了 `wrangler.jsonc` 中全零的 `database_id`；若未自动替换，只手动填入该字段返回的 ID。
3. 保持 `USAGE_SOURCE=fixture` 与 `OPENCODE_CONSOLE_ENABLED=false`，首次部署以创建 Worker 并取得 HTTPS origin：

   ```powershell
   npm run deploy
   ```

   在 Worker 已创建、但所需 Secret 尚未设置的短暂窗口内，定时调用可能因缺少 Secret 产生错误；请立即完成下一步。此时仍为夹具来源，不会读取真实 OpenCode 会话。
4. 交互式设置 PushPlus 与手动触发 Secret。Secret 保存在 Cloudflare Worker 的 Secret 存储中，而不在仓库、D1 或 `wrangler.jsonc`：

   ```powershell
   npx wrangler secret put PUSHPLUS_TOKEN
   npx wrangler secret put PUSHPLUS_TOPIC
   npx wrangler secret put PUSHPLUS_CALLBACK_SECRET
   npx wrangler secret put PUSHPLUS_CALLBACK_BASE_URL
   ```

   `PUSHPLUS_CALLBACK_BASE_URL` 必须使用上一步取得的 origin，格式严格为 `https://<worker-host>`，不含路径、查询或片段。回调密钥与 `MANUAL_TRIGGER_SECRET` 均至少 32 个字符；回调密钥可由密码管理器生成后在 Wrangler 提示中直接粘贴。

   手动触发密钥必须让 Cloudflare Worker 与 GitHub Actions 使用同一个值。以下 PowerShell 在当前进程内生成随机值，再分别通过标准输入同步到两个 Secret 存储；密钥不会进入文件、命令参数或日志，也不会在终端回显：

   ```powershell
   $manualSecretBytes = [byte[]]::new(32)
   [Security.Cryptography.RandomNumberGenerator]::Fill($manualSecretBytes)
   $manualTriggerSecret = [Convert]::ToHexString($manualSecretBytes).ToLowerInvariant()

   $manualTriggerSecret | npx wrangler secret put MANUAL_TRIGGER_SECRET
   if ($LASTEXITCODE -ne 0) { throw 'Cloudflare 手动触发密钥同步失败。' }

   $manualTriggerSecret | gh secret set MANUAL_TRIGGER_SECRET
   if ($LASTEXITCODE -ne 0) { throw 'GitHub 手动触发密钥同步失败。' }

   [Array]::Clear($manualSecretBytes, 0, $manualSecretBytes.Length)
   $manualTriggerSecret = $null
   ```

   程序每次投递都会自动附带包含事件 ID、过期时间与签名的完整回调 URL；无需在 PushPlus 单独配置固定回调地址。
5. 运行授权工具，在其打开的浏览器中人工完成 GitHub 登录并进入目标工作区即可；工具会自动打开用量页、校验结果并上传会话，不需要手动进入 Go/Usage 页面、捕获 `_server` 响应或在终端按回车：

   ```powershell
   npm run auth:setup
   ```

   工具会验证用量请求后，直接通过标准输入上传 `OPENCODE_SESSION_BUNDLE` 到 Cloudflare Secret；会话不进入文件、命令参数、D1、日志或 Git。
6. 确认夹具部署和 PushPlus 投递可用后，才将 `USAGE_SOURCE` 改为 `opencode-console`、将 `OPENCODE_CONSOLE_ENABLED` 改为 `true`，并最终部署：

   ```powershell
   npm run deploy
   ```

`OPENCODE_SESSION_BUNDLE` 已列为部署所需 Secret，但示例文件和版本控制中不会包含它或任何 Cookie 内容。

## GitHub 手动广播

手动广播不受夜间静默时段限制。先把与 Cloudflare Worker 相同的 `MANUAL_TRIGGER_SECRET` 保存为仓库的 GitHub Actions Secret；不要把该值写入文件、命令参数或日志。随后打开仓库的“Actions”页面，选择“手动发送 OpenCode Go 用量”，点击“Run workflow”即可。工作流会用本次运行编号生成幂等键，并调用生产 Worker 的安全入口；同一次运行重试不会重复创建广播。

## 真实来源、会话续期与回退

真实来源依赖当前 OpenCode 控制台的内部协议，可能随时变化。请持续关注 [OpenCode issue 16017](https://github.com/anomalyco/opencode/issues/16017) 和尚未合并的 [PR 16513](https://github.com/anomalyco/opencode/pull/16513)。

若通知显示登录失效，或真实采集返回认证故障，请重新运行 `npm run auth:setup` 完成人工 GitHub 登录并上传新会话，然后再次部署真实来源。会话更新会产生新的授权代次并允许一次恢复探测。

若要停止真实采集，立即将 `USAGE_SOURCE` 改回 `fixture`，将 `OPENCODE_CONSOLE_ENABLED` 改回 `false` 后部署。需要彻底撤销授权时，在 Cloudflare 删除 `OPENCODE_SESSION_BUNDLE`，并在 OpenCode/GitHub 侧撤销相应会话；Worker 仍可用夹具继续验证投递链路。

## 故障分类

- 认证故障：会话过期、401、403 或登录跳转。重新运行 `npm run auth:setup`。
- 暂时故障：网络超时、429、408 或 5xx。任务会有限重试；稍后检查 OpenCode 服务状态。
- 格式故障：响应结构不符合预期，通常意味着内部协议变更。停止真实来源并等待适配更新。
- 采集器禁用：`USAGE_SOURCE=opencode-console` 但开关未启用时会安全跳过，不发起真实网络请求。

## 发布前检查

仅在完成预定改动后运行一次：

```powershell
npm run check
```

再执行以下扫描。无匹配时 `git grep` 返回 1，脚本会将其视为成功；历史计划文件因包含经审阅的扫描字面量而被精确排除。

```powershell
$credentialPattern = '(' + 'g' + 'hp_|github' + '_pat_|\bsk-[A-Za-z0-9]|Cookie' + ':|Set-Cookie' + ':)'
$scanOutput = & git grep -n -I -E $credentialPattern -- ':!docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md'
if ($LASTEXITCODE -ne 1 -or $scanOutput) { $scanOutput; throw '凭据样式扫描失败。' }
```

```powershell
$todoPattern = '(' + 'TO' + 'DO|TB' + 'D)'
$todoOutput = & git grep -n -I -E $todoPattern -- ':!docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md'
if ($LASTEXITCODE -ne 1 -or $todoOutput) { $todoOutput; throw '占位标记扫描失败。' }
```

消息最多尝试投递三次。整点与手动广播会在下一个上海整点过期；故障与恢复消息在 24 小时后过期。
