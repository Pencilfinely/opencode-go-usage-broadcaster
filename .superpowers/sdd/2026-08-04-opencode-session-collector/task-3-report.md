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

## 修复轮次 1

- 首次部署顺序已改为先以夹具创建 Worker，再设置四个 PushPlus Secret、上传会话，最后启用真实来源。
- `PUSHPLUS_CALLBACK_BASE_URL` 现明确限定为首次部署取得的 HTTPS origin，且不含路径、查询或片段。
- 已删除要求在 PushPlus 手工配置固定回调地址的说明；程序会在每次投递时自动附带已签名、含事件 ID 与过期时间的完整回调 URL。

### 本轮验证

本轮未运行完整检查。已执行下列命令并获得预期结果：

```powershell
git diff --check
```

结果：通过，无输出。

```powershell
$credentialPattern = '(' + 'g' + 'hp_|github' + '_pat_|\bsk-[A-Za-z0-9]|Cookie' + ':|Set-Cookie' + ':)'
& git grep -n -I -E $credentialPattern -- ':!docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md'
```

结果：无匹配，`git grep` 退出码为 1。

```powershell
$todoPattern = '(' + 'TO' + 'DO|TB' + 'D)'
& git grep -n -I -E $todoPattern -- ':!docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md'
```

结果：无匹配，`git grep` 退出码为 1。
