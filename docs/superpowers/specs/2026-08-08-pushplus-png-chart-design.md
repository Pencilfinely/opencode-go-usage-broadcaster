# PushPlus PNG 图表可靠推送设计

## 目标

解决 PushPlus 消息详情中的用量图表经常加载失败的问题。新消息不再让微信客户端直接读取 `workers.dev` 上的 SVG，而是在广播创建阶段生成 PNG，上传到 PushPlus 官方图片服务，再把 `pic.pushplus.plus` 地址写入消息正文。

三项 Go 额度、最近 24 小时文字汇总、模型排行、整点规则、手动触发和消息重试行为保持不变。图片链路发生任何故障时，本次广播仍发送完整文字内容。

## 已确认的产品与安全决策

- 使用 Cloudflare Browser Run Quick Action 把现有 720×360 SVG 转成 PNG。
- PNG 上传到 PushPlus 官方图片服务，不继续把 `workers.dev` 作为新消息的图片源。
- PushPlus 开放接口的 IP 白名单关闭。普通 Cloudflare Worker 没有固定出口 IP，无法稳定通过固定 IP 白名单；用户已明确接受这一安全取舍。
- PushPlus 开放接口使用强随机 `SecretKey`，只保存为 Cloudflare Worker Secret，不写入仓库、普通变量、消息或日志。
- 现有 `PUSHPLUS_TOKEN` 必须是用户 Token；PushPlus 的消息 Token 不能换取 AccessKey。
- 图片生成、鉴权或上传失败时发送纯文字消息，不回退到已知不稳定的外链 SVG。
- 历史消息继续使用原有签名 SVG，旧路由和快照保留至原定 30 天清理周期结束。
- 以快速可靠落地为主，只增加与 PNG、官方图片上传和降级直接相关的测试。

## 方案选择

### 采用：Browser Run 截图加 PushPlus 官方图片服务

Browser Run 可以直接复用当前 SVG，运行环境包含中文字体，不需要把字体或大型 WASM 打进 Worker。当前每天 09:00 至 23:00 最多 15 次自动广播，另有少量手动广播，低于 Browser Run 免费额度的常规使用范围。上线后仍要记录单次浏览器耗时并观察额度。

PushPlus 官方图片服务返回 `pic.pushplus.plus` 地址，避免微信客户端跨境访问 `workers.dev`。该服务的图片最长保留 30 天，单图不得超过 10 MB；本项目进一步把 PNG 限制为 2 MiB。

PushPlus 当前把图片服务列为收费能力，会员用户限时免费使用。生产启用前必须确认当前账号能够取得上传凭证；若账号无权限，代码自动发送文字版，但无法实现官方 CDN 图表，需由用户开通相应能力或另选图床。

### 不采用：Worker 继续公开 PNG

把 SVG 改成 PNG 但继续放在 `workers.dev`，只能减少渲染兼容问题，不能解决大陆微信客户端访问该域名时的网络可靠性问题。

### 不采用：`resvg-wasm` 或自写 PNG 光栅器

`resvg-wasm` 还需要携带中文字体并承担包体、初始化和 CPU 风险；自写光栅器需要自行维护文字排版、像素绘制、PNG 分块、CRC 和压缩。两者都比 Browser Run 复杂，不符合本次快速实现目标。

### 不采用：固定 IP 上传中控

固定出口中控可以保留 PushPlus IP 白名单，但会新增一台长期运行的服务器、鉴权协议和运维成本。当前用户已接受关闭 IP 白名单，因此不增加该组件。

## 新广播链路

每次自动或手动广播沿用现有租约和幂等逻辑，按以下顺序执行：

1. 采集 `/go` 与 `/usage` 数据并生成最近 24 小时聚合结果。
2. 先生成不含图片的完整文字消息，确保后续任何图片故障都能降级。
3. 使用现有 SVG 渲染器生成固定 720×360 的自包含 SVG。
4. 调用 Browser Run Quick Action 对该 SVG 截图，得到 PNG 字节。
5. 使用用户 Token 和 `PUSHPLUS_SECRET_KEY` 获取短期 AccessKey。
6. 使用 AccessKey 获取一次性图片上传凭证。
7. 把 PNG 以 `multipart/form-data` 上传至响应中经过白名单校验的七牛 HTTPS 地址。
8. 严格验证上传结果，将 `https://pic.pushplus.plus/...` 写入富文本消息。
9. 把最终消息一次性提交到现有 outbox，再沿用现有 PushPlus 三次投递重试。

图片只在创建广播事件时生成和上传一次。outbox 一旦提交，后续消息重试复用已固化的 HTML 和图片地址，不重复截图或上传。

## PNG 生成边界

新增 `BROWSER` Browser Run binding。生产渲染器只接收用量图表数据，不接收任意 HTML 或 URL；它调用现有 SVG 渲染器，并将 SVG 放入固定模板中。

浏览器参数固定为：

- 视口与输出尺寸均为 720×360；
- PNG、白色背景、设备像素比 1；
- JavaScript 禁用；
- 页面 CSP 禁止网络资源；
- 最长执行 10 秒；
- 不启用截图缓存。

响应必须同时满足：HTTP 200、`Content-Type` 为 `image/png`、大小不超过 2 MiB、PNG 魔数正确、IHDR 尺寸为 720×360。任一条件不满足即视为图片失败并触发文字降级。

## PushPlus 图片客户端

本项目使用 Worker 原生 `fetch` 与 `FormData` 实现最小客户端，不引入完整 PushPlus SDK。调用顺序为：

1. `POST /api/common/openApi/getAccessKey`；
2. `GET /api/open/userImage/uploadToken`；
3. 向返回的七牛上传地址提交 `token` 与 PNG `Blob`。

AccessKey 全局唯一且约两小时有效，重复获取会使旧 Key 失效。本项目已有广播创建租约，且每次只在取得 AccessKey 后立即领取上传凭证，因此快速版本不把高权限 AccessKey 持久化到 D1，而是每个新广播获取一次并立即使用。这样避免在数据库保存短期高权限凭据，也避免跨 Worker isolate 的内存缓存不一致。

如果同一 PushPlus 账户未来还有其他开放接口客户端，需要改成唯一的集中式 AccessKey 刷新者；这不属于本次范围。

所有响应都需要 HTTP 状态、JSON 类型和业务状态三重校验。上传地址只允许 PushPlus 返回的已知七牛 HTTPS 主机，禁用重定向；最终图片地址必须使用 HTTPS，且主机精确等于 `pic.pushplus.plus`。PNG MIME、文件大小和成功码也必须一致。

## 配置与密钥

新增：

- Worker binding：`BROWSER`；
- Worker Secret：`PUSHPLUS_SECRET_KEY`。

继续使用现有 `PUSHPLUS_TOKEN` 作为发送与开放接口的用户 Token。部署前需要在 PushPlus「开发设置」中：

1. 开启开放接口；
2. 配置与 Worker Secret 相同的强随机 SecretKey；
3. 关闭 IP 白名单；
4. 用一次真实 AccessKey 请求确认设置生效。

日志不得包含用户 Token、SecretKey、AccessKey、上传 Token、PNG 字节、完整上传地址或完整图片地址。

## 失败与降级

以下任一情况只记录脱敏的结构化警告，并发送完整文字消息：

- Browser Run 超时、限流、额度不足或返回异常图片；
- AccessKey 获取失败，包括 Token 类型错误或开放接口未启用；
- 上传凭证获取失败；
- 七牛上传失败、重定向、超时或响应校验失败；
- 最终图片 URL 不属于 `pic.pushplus.plus`；
- 富文本消息生成失败。

图片失败不得把本次广播标记为采集失败，也不得阻止三项额度和 24 小时明细发送。PushPlus 消息投递本身的失败继续沿用现有 outbox 重试规则。

图片上传与 D1 提交无法组成事务。若上传成功后提交失败，可能留下无人引用的图片；PushPlus 会在 30 天后自动清理，接受这一有限残留，不增加补偿任务。

## 历史兼容与清理

新消息不再创建新的签名 SVG 图片地址。现有 `/charts/usage/*.svg` 路由、`USAGE_CHART_SIGNING_SECRET`、`PUBLIC_BASE_URL` 和 `usage_chart_snapshots` 暂时保留，让已经发送的消息继续显示。

原有快照仍按 30 天清理。最后一批旧消息过期后，可在单独变更中删除 SVG 路由、签名配置、快照表和迁移；本次不做破坏性清理。

## 可观察性

只记录以下非敏感字段：

- 广播事件编号；
- 阶段：PNG 渲染、AccessKey、上传凭证、图片上传或消息生成；
- 归一化错误类别与上游 HTTP 状态；
- Browser Run 返回的执行毫秒数；
- 是否使用文字降级。

不记录外部响应正文。对 Browser Run 429 不做立即连打；本次直接降级，下次正常广播再尝试。

## 精简测试范围

- PNG 渲染器：固定 Browser Run 参数；合法 720×360 PNG 成功；错误状态、错误 MIME、超限字节、错误魔数和错误尺寸失败。
- PushPlus 图片客户端：AccessKey、上传凭证和 multipart 主路径；消息 Token/业务错误；重定向；非法上传主机；非法最终 URL；敏感内容不进入错误文本。
- 应用层：图片成功时 outbox 固化 `pic.pushplus.plus` URL；渲染或上传失败时仍只创建一条完整文字消息；PushPlus 消息重试不重复上传。
- 回归：现有额度、24 小时聚合、定时窗口、手动触发、幂等和旧 SVG 路由测试继续通过。

本地单元测试使用假的 Browser binding 和假的上游响应。正式发布前只做一次远程手动广播冒烟，确认 PushPlus 消息详情能够读取尺寸正确的 PNG，并在微信详情页稳定显示。官方图片带有 `pushplus.plus` 域名使用限制，不把脱离消息详情的匿名直链访问作为验收条件。

## 上线顺序

1. 在 PushPlus 开发设置中开启开放接口、配置 SecretKey、关闭 IP 白名单。
2. 确认当前 PushPlus 账号具备图片服务权限。
3. 将同一 SecretKey 写入 Cloudflare `PUSHPLUS_SECRET_KEY` Secret。
4. 部署带 `BROWSER` binding 的 Worker。
5. 先验证 AccessKey 和上传凭证，再执行一次手动广播。
6. 确认消息文字完整、PNG 地址属于 `pic.pushplus.plus`、微信详情页可显示。
7. 观察下一次整点广播以及 Browser Run 用量和降级日志。

任何真实验证失败都停止继续扩大变更，现有文字广播仍可工作。

## 验收标准

- 新消息中的图表为 720×360 PNG，地址来自 `pic.pushplus.plus`，不再依赖 `workers.dev` 图片请求。
- 微信 PushPlus 详情页能稳定显示图表，图表加载失败时文字汇总仍完整可读。
- 自动广播仍为北京时间 09:00 至 23:00 每小时一次，00:00 至 08:59 不发送；手动触发不受时间窗口限制。
- 同一广播事件只截图和上传一次；消息投递重试不重复生成图片。
- 任何日志、仓库文件和消息内容均不泄露 PushPlus 开放接口凭据。
- 旧消息的签名 SVG 在原 30 天有效期内继续可访问。

## 设计依据

- [PushPlus 开放接口文档](https://www.pushplus.plus/doc/guide/openApi.html)
- [PushPlus 图片服务](https://www.pushplus.plus/doc/function/image.html)
- [Cloudflare Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/)
- [Cloudflare Browser Run 截图接口](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
- [Cloudflare Browser Run 字体](https://developers.cloudflare.com/browser-run/reference/supported-fonts/)
- [Cloudflare Browser Run 限额](https://developers.cloudflare.com/browser-run/limits/)
- [Cloudflare 专用出口 IP](https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/dedicated-egress-ips/)
