# OpenCode 会话用量采集设计

## 目标

在不保存 GitHub 密码、验证码或 GitHub 会话的前提下，由账户持有人一次性在本机浏览器中完成 OpenCode 登录，将 OpenCode 自身的 `auth` 会话作为 Cloudflare Secret 保存。Cloudflare Worker 每 30 分钟读取真实的滚动、每周和每月用量，并沿用现有 D1 去重、阈值判断和 PushPlus 广播能力。

## 边界与风险

- OpenCode 当前没有已发布的稳定用量接口；本实现复用网页正在使用的内部请求，因此属于易受上游页面改版影响的适配器。
- 只处理 `https://opencode.ai` 的请求和名为 `auth` 的 OpenCode Cookie；不读取或保存 GitHub 密码、GitHub Cookie、访问令牌和验证码。
- 会话本身等同于登录凭据，只能进入 Cloudflare Secret，不进入命令参数、文件、D1、日志、测试夹具或 Git。
- 会话过期或内部协议变化时停止更新真实用量，并只发送一次对应故障通知；账户持有人重新运行授权工具即可轮换会话。

## 架构

### 一次性授权工具

`npm run auth:setup` 创建临时浏览器资料目录，并打开本机 Chrome 或 Edge。用户手动完成 GitHub 登录并进入 OpenCode Go 用量页。工具监听 `opencode.ai` 的响应，识别同时包含 `rollingUsage`、`weeklyUsage`、`monthlyUsage` 的请求，只保留：

- OpenCode `auth` Cookie 的值；
- 当前工作区 ID；
- 内部请求的 HTTPS URL、GET/POST 方法、必要的安全请求头和可选请求体；
- 随机生成的会话代次和格式版本。

工具先用 Node.js 自带的独立 `fetch` 重放一次并校验三个用量窗口，再通过标准输入执行 `wrangler secret put OPENCODE_SESSION_BUNDLE`。无论成功、失败或取消，都关闭浏览器并删除临时资料目录。

### Worker 采集器

真实采集器从 `OPENCODE_SESSION_BUNDLE` 读取请求描述和会话。每次调用只允许 HTTPS、主机 `opencode.ai`、标准端口和 `/_server` 路径；禁止 URL 用户信息、任意重定向、任意请求头和超限请求体。响应设定超时与体积上限，递归查找三个用量窗口，将 `usagePercent` 和 `resetInSec` 转换为现有 `QuotaSnapshot`。

会话包中的随机 `generation` 同时作为现有认证故障门的代次。上传新 Secret 后，下一次定时任务会自动解除旧会话的认证阻断。

## 错误处理

- `401`、`403` 或跳转到登录页：认证故障，同一会话代次只通知一次并停止继续请求。
- `429`、超时、网络错误或 `5xx`：临时故障，沿用现有有限重试与连续失败通知。
- 请求描述非法、响应超限、JSON 无法解析或字段变化：格式故障，不写入新的配额状态。
- 其他重定向和非预期状态码：按格式故障关闭处理，绝不跟随到其他来源。

## 配置与运行

- 默认仍为 `USAGE_SOURCE=fixture`，便于安全回退。
- 启用真实采集需要同时设置 `USAGE_SOURCE=opencode-console` 与 `OPENCODE_CONSOLE_ENABLED=true`，并存在 `OPENCODE_SESSION_BUNDLE` Secret。
- 定时频率保持每 30 分钟，另保留北京时间 09:07 日报。
- 部署顺序为：创建并迁移 D1、配置 PushPlus Secret、部署 Worker、运行一次授权工具、切换真实来源并核对三个窗口。

## 最小验证范围

自动测试只覆盖五条关键路径：真实响应规范化、认证失效、格式变化、固定来源安全校验、会话代次轮换。授权工具不连接真实 GitHub 或 OpenCode 做自动化测试；真实登录和首次重放由账户持有人在部署阶段完成。

## 回退与撤销

出现异常时把 `USAGE_SOURCE` 切回 `fixture` 或回滚到上一 Worker 版本。需要撤销授权时删除 `OPENCODE_SESSION_BUNDLE` Secret，并在 OpenCode 退出登录；临时浏览器资料目录不会保留。
