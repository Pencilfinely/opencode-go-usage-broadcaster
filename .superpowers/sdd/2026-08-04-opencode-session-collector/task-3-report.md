# Task 3：配置说明与交付报告

## 完成内容

- 在 `wrangler.jsonc` 的必需 Secret 列表中加入 `OPENCODE_SESSION_BUNDLE`；默认仍为夹具来源，且控制台采集开关保持关闭。
- 保持 `.dev.vars.example` 仅含不可用的 PushPlus 示例值，并明确不应保存 OpenCode 会话。
- 将 `README.md` 全面改写为中文操作手册，覆盖架构、首次部署顺序、人工授权、真实来源切换、会话续期、故障处理和回退。
- 文档明确会话包仅经标准输入上传至 Cloudflare Secret，不写入文件、参数、D1、日志或 Git；未添加可用凭据或 Cookie 示例。
- 保留 OpenCode issue 16017 与未合并 PR 16513 的链接，并提示内部协议可能变化。

## 验证

- 已在最终修改后执行一次 `npm run check`。
- 已使用 `git grep` 扫描凭据样式与待办占位标记；历史计划文件因含经审阅的字面扫描文本而作精确排除。

## 外部操作边界

本任务未执行 Cloudflare 登录、D1 创建或迁移、Secret 设置、授权登录、会话上传和部署。README 仅给出这些操作的顺序与命令。
