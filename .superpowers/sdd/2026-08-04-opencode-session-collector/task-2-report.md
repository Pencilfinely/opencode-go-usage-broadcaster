# 任务二：一次性本机授权工具报告

## 实现内容

- 新增 `npm run auth:setup`，以可见的本机 Chrome 优先、Edge 兜底方式启动临时浏览器资料目录。
- 工具只观察 `https://opencode.ai/_server` 响应；仅在响应能规范化为三个用量窗口时保留经过安全校验的请求描述。
- 用户完成 GitHub 登录并返回 Go 页面后，工具仅读取 OpenCode 域名下名称严格为 `auth` 的 Cookie，构造并再次校验 V1 会话包。
- 使用 Node 独立 `fetch` 重放会话；成功时仅输出滚动、周、月三个用量百分比。会话 JSON 仅写入 `npx(.cmd) wrangler secret put OPENCODE_SESSION_BUNDLE` 的标准输入。
- 无论浏览器关闭是否报错，都会继续删除已解析的临时资料目录。

## 测试与验证

- `npx tsx --test scripts/auth-setup.test-node.ts`：通过，验证会话内容仅经子进程标准输入传递，不出现于命令参数、环境变量或日志。
- `npm run typecheck`：通过，包含 `scripts/**/*.ts` 的 TypeScript 检查。

## 已知顾虑

- 该工具需要本机已安装 Chrome 或 Edge，并由操作者完成真实 GitHub 登录；按约束未自动化浏览器或外部服务。
