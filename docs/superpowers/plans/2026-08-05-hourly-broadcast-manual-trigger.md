# 整点广播与手动触发实施计划

> **供智能代理执行：** 必须使用 `superpowers:subagent-driven-development`，按任务执行、测试、提交并逐项审查。

**目标：** 将生产 Worker 改为北京时间每天 09:00–23:00 每整点发送一条当前 OpenCode Go 用量，并提供 GitHub 按钮触发的安全手动发送。

**架构：** 保留现有 OpenCode 采集、D1 快照租约、任务去重和发件箱。把定时编排核心改为显式的 `scheduled | manual` 广播触发；定时逻辑键按上海日期和小时生成，手动逻辑键按幂等键摘要生成。PushPlus 接口返回接受成功后立即终结发件箱事件，避免因缺少回调而重复发送。

**技术栈：** TypeScript、Cloudflare Workers、D1、Wrangler 4、Vitest Workers Pool、GitHub Actions。

## 全局约束

- 自动广播仅允许北京时间每天 09:00 至 23:00 整点；00:00 至 08:59 不自动发送。
- Cloudflare Cron 固定为 UTC `0 1-15 * * *`，应用层仍必须按 `Asia/Shanghai` 二次校验。
- 每个正常整点只发送一条当前用量；不再创建启动、阈值或 09:07 每日汇总消息。
- 手动触发使用精确路径 `POST /admin/manual-trigger`，不受静默时段限制。
- 手动鉴权 Secret 名为 `MANUAL_TRIGGER_SECRET`，至少 32 个字符，只保存于 Cloudflare 与 GitHub Secret。
- 手动请求必须携带 16–128 字符的 `Idempotency-Key`；数据库只保存其 SHA-256 摘要。
- PushPlus API 接受消息后视为成功，不因回调缺失而重发。
- 所有 GitHub 可见文字、提交、PR、工作流名称和代码注释使用中文；平台规定的字段名和代码标识符除外。
- 仅添加能捕获时段、幂等、鉴权和重复投递故障的测试，不增加源码文本扫描类测试。

---

### 任务 1：PushPlus 接受即成功与旧消息清理

**文件：**

- 修改：`src/repository.ts`
- 修改：`test/repository.test.ts`
- 修改：`test/pushplus.test.ts`
- 新建：`migrations/0004_expire_legacy_broadcast_events.sql`

**接口：**

- 保持 `Repository.markAttemptAccepted(eventId, attemptNo, owner, shortCode, now): Promise<boolean>` 签名不变。
- 成功后 `outbox_events.status='succeeded'`、对应 `outbox_attempts.status='succeeded'`，阈值触发记录如存在则为 `delivered`。
- 后续同一成功回调仍幂等返回成功；失败回调不能把已成功事件改回重试状态。

- [ ] **步骤 1：先写失败测试**

  在 `test/repository.test.ts` 调整现有成功投递用例，使其在调用 `markAttemptAccepted` 后、调用任何回调前直接断言：

  ```ts
  expect(await env.DB.prepare(
    "SELECT status FROM outbox_events WHERE id = 'event-success'"
  ).first()).toEqual({ status: "succeeded" });
  expect(await env.DB.prepare(
    "SELECT status FROM outbox_attempts WHERE event_id = 'event-success'"
  ).first()).toEqual({ status: "succeeded" });
  ```

  保留成功回调幂等断言，并新增失败回调返回 `false` 的断言。该测试捕获“接口已接受但事件仍等待回调并再次发送”的故障。

- [ ] **步骤 2：运行测试确认按预期失败**

  运行：

  ```powershell
  npx vitest run test/repository.test.ts test/pushplus.test.ts
  ```

  预期：成功投递用例在 `waiting_callback`/`accepted` 与期望的 `succeeded` 不一致处失败。

- [ ] **步骤 3：实现最小状态转换**

  修改 `markAttemptAccepted` 的原子批处理：

  ```ts
  // 尝试记录 PushPlus 消息编号，并把当前 attempt 直接设为 succeeded。
  // 仅当 attempt 更新成功时，才把同一发送租约下的 event 设为 succeeded。
  // 最后把该 event 的 reserved trigger 设为 delivered。
  ```

  保留租约、attempt 编号、过期时间和消息编号守卫，确保旧响应不能终结新尝试。

- [ ] **步骤 4：添加一次性数据清理迁移**

  `0004` 只处理迁移执行时仍活动的旧 `startup`、`threshold`、`daily` 事件：先把活动 attempt 设为 `unknown`，再把事件设为 `expired` 并释放租约，最后把关联的 `reserved` trigger 设为 `abandoned`。保留所有已成功、已死亡或已过期历史记录。

- [ ] **步骤 5：运行定向测试并提交**

  运行：

  ```powershell
  npx vitest run test/repository.test.ts test/pushplus.test.ts
  git diff --check
  ```

  提交：

  ```powershell
  git add src/repository.ts test/repository.test.ts test/pushplus.test.ts migrations/0004_expire_legacy_broadcast_events.sql
  git commit -m "避免 PushPlus 回调缺失导致重复发送"
  ```

---

### 任务 2：北京时间整点广播编排

**文件：**

- 修改：`src/app.ts`
- 修改：`src/rules.ts`
- 修改：`src/index.ts`
- 修改：`test/app.test.ts`
- 修改：`wrangler.jsonc`

**接口：**

- 新增 `BroadcastTrigger`：

  ```ts
  export type BroadcastTrigger =
    | { type: "scheduled"; occurredAt: number }
    | { type: "manual"; occurredAt: number; idempotencyDigest: string };
  ```

- 新增 `runBroadcast(trigger, env, deps?): Promise<"completed" | "duplicate" | "busy">`，复用现有采集、租约、状态提交和投递流程。
- `runScheduled(controller, env, ctx, deps?)` 保持为 Cloudflare 适配器，并在调用核心前执行时段校验。
- 新增 `isShanghaiBroadcastSlot(timestamp): boolean`，仅在上海时区 09:00–23:00 且分钟为 00 时返回真。
- 新增 `renderBroadcastMessage(snapshot, eventId, manual): RenderedMessage`；定时标题为“OpenCode Go 整点用量”，手动标题为“OpenCode Go 手动用量”。

- [ ] **步骤 1：写时段和每小时必发的失败测试**

  在 `test/app.test.ts` 用字面量时间覆盖：

  ```ts
  [
    ["2026-08-05T00:59:00Z", false], // 北京 08:59
    ["2026-08-05T01:00:00Z", true],  // 北京 09:00
    ["2026-08-05T15:00:00Z", true],  // 北京 23:00
    ["2026-08-05T16:00:00Z", false]  // 北京次日 00:00
  ]
  ```

  再执行 09:00 和 10:00 两个成功快照，断言生成两个 `logical_key` 分别为 `broadcast:scheduled:2026-08-05:09` 和 `broadcast:scheduled:2026-08-05:10` 的汇总事件；重复执行 10:00 不新增第三条。该测试必须先因旧启动/阈值/每日逻辑而失败。

- [ ] **步骤 2：运行测试确认按预期失败**

  ```powershell
  npx vitest run test/app.test.ts
  ```

  预期：时段函数不存在或旧编排未创建稳定的整点汇总键。

- [ ] **步骤 3：实现整点广播核心**

  - 把任务键和事件键统一为 `broadcast:scheduled:<上海日期>:<两位小时>`。
  - 正常采集后始终创建一个内部 kind 为 `daily` 的汇总事件，过期时间为下一个上海整点。
  - 不再把 `evaluation.notifications`、`startupCreated` 或 `dailyDue` 转成正常用量事件；仍保存 `evaluateSnapshot` 产生的最新 quota 状态。
  - 将连续暂时故障槽位间隔由 30 分钟改为 1 小时。
  - 手动触发接口先留在 `runBroadcast`，具体 HTTP 鉴权在任务 3 完成。
  - `runScheduled` 在静默时段必须在调用 `dispatchDue` 之前返回。

- [ ] **步骤 4：更新 Cron 并运行定向测试**

  `wrangler.jsonc`：

  ```json
  "triggers": {
    "crons": ["0 1-15 * * *"]
  }
  ```

  运行：

  ```powershell
  npx vitest run test/app.test.ts test/rules.test.ts
  npm run typecheck
  git diff --check
  ```

- [ ] **步骤 5：提交**

  ```powershell
  git add src/app.ts src/rules.ts src/index.ts test/app.test.ts wrangler.jsonc worker-configuration.d.ts
  git commit -m "改为北京时间每小时广播用量"
  ```

---

### 任务 3：安全手动入口与 GitHub 按钮

**文件：**

- 新建：`src/manual-trigger.ts`
- 新建：`test/manual-trigger.test.ts`
- 新建：`.github/workflows/manual-broadcast.yml`
- 修改：`src/index.ts`
- 修改：`src/config.ts`
- 修改：`test/config-source.test.ts`
- 修改：`test/env.d.ts`
- 修改：`.dev.vars.example`
- 修改：`wrangler.jsonc`
- 修改：`worker-configuration.d.ts`
- 修改：`README.md`

**接口：**

- `AppConfig` 新增 `manualTriggerSecret: string`。
- `handleManualTrigger(request, config, run, clock = Date.now): Promise<Response>` 只接受精确路径与 POST；`run` 接收 `BroadcastTrigger` 并返回任务结果，`clock` 仅用于可重复验证服务端时间。
- `Idempotency-Key` 允许正则 `^[A-Za-z0-9._:-]{16,128}$`。
- 鉴权时分别 SHA-256 Bearer 值和配置 Secret，再用 `crypto.subtle.timingSafeEqual` 比较固定 32 字节摘要。
- 正确请求调用：

  ```ts
  await run({
    type: "manual",
    occurredAt: Date.now(),
    idempotencyDigest: await sha256Hex(idempotencyKey)
  });
  ```

- 完成或重复请求返回 204；租约繁忙返回 503；路径、方法或鉴权失败统一返回 404；幂等键格式错误返回 400。所有错误正文都不包含内部细节。

- [ ] **步骤 1：写入口契约失败测试**

  在 `test/manual-trigger.test.ts` 覆盖以下可观察行为：

  - GET、带查询串、缺失或错误 Bearer 不调用 `run`。
  - 过短或含非法字符的 `Idempotency-Key` 不调用 `run`。
  - 正确请求在北京时间夜间仍调用一次 `run`，传入 64 位十六进制摘要而非原始幂等键，并返回 204。
  - 相同请求的去重由 `runBroadcast` 的任务键保证；入口不自行缓存全局状态。

  在 `test/config-source.test.ts` 增加 Secret 缺失和少于 32 字符时拒绝加载的用例。

- [ ] **步骤 2：运行测试确认按预期失败**

  ```powershell
  npx vitest run test/manual-trigger.test.ts test/config-source.test.ts
  ```

  预期：模块/配置字段不存在导致失败。

- [ ] **步骤 3：实现鉴权、路由和类型**

  - `src/manual-trigger.ts` 只负责 HTTP 契约、摘要和鉴权，不直接操作 D1 或 PushPlus。
  - `src/index.ts` 先精确识别 `/admin/manual-trigger`，同步 `await` 处理；PushPlus 回调路由保持原有签名校验。
  - `wrangler.jsonc` 的 `secrets.required` 增加 `MANUAL_TRIGGER_SECRET`，运行 `npm run typegen` 更新类型。

- [ ] **步骤 4：增加 GitHub 手动按钮**

  `.github/workflows/manual-broadcast.yml` 使用：

  ```yaml
  name: 手动发送 OpenCode Go 用量
  on:
    workflow_dispatch:
  permissions: {}
  ```

  工作流通过 Node `fetch` 向生产 Worker 的 `/admin/manual-trigger` 发送 POST；鉴权从 `${{ secrets.MANUAL_TRIGGER_SECRET }}` 读取，幂等键使用 `manual-${{ github.run_id }}`。响应不是 2xx 时以中文错误结束，不打印 Secret。

- [ ] **步骤 5：更新中文文档并验证**

  README 必须写明：09:00–23:00 整点广播、夜间静默、GitHub Actions 点击路径、手动触发绕过静默、Secret 配置方法，以及 PushPlus 接受后不再因回调缺失重发。

  运行：

  ```powershell
  npx vitest run test/manual-trigger.test.ts test/config-source.test.ts test/app.test.ts
  npm run typecheck
  git diff --check
  ```

- [ ] **步骤 6：提交**

  ```powershell
  git add src/manual-trigger.ts test/manual-trigger.test.ts .github/workflows/manual-broadcast.yml src/index.ts src/config.ts test/config-source.test.ts test/env.d.ts .dev.vars.example wrangler.jsonc worker-configuration.d.ts README.md
  git commit -m "增加安全手动广播按钮"
  ```

---

### 任务 4：全量验证、生产部署与中文 PR

**文件：**

- 检查：本计划涉及的全部文件
- 外部状态：Cloudflare Worker Secret、GitHub Actions Secret、D1 migration、Worker 部署、GitHub PR

**接口：**

- Cloudflare 与 GitHub 使用同一个随机 `MANUAL_TRIGGER_SECRET`，但整个过程中不打印或写入仓库。
- 生产 Worker URL 为 `https://opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`。

- [ ] **步骤 1：运行完整验证**

  ```powershell
  npm run check
  npx tsx --test scripts/auth-setup.test-node.ts
  git diff --check
  ```

  预期：全部测试、类型检查和授权工具测试通过，无空白错误。

- [ ] **步骤 2：安全同步手动 Secret**

  在本机进程内生成至少 32 个随机字节；通过标准输入分别写入 `npx wrangler secret put MANUAL_TRIGGER_SECRET` 和 `gh secret set MANUAL_TRIGGER_SECRET`。不得把值放入命令参数、文件、输出或日志。

- [ ] **步骤 3：应用迁移并部署**

  ```powershell
  npx wrangler d1 migrations apply opencode-go-usage --remote
  npx wrangler deploy
  ```

  核对部署输出仅包含 Cron `0 1-15 * * *`。

- [ ] **步骤 4：执行一次真实手动验证**

  使用进程内 Secret 对生产 `/admin/manual-trigger` 发起 POST，幂等键使用新的随机值。确认 HTTP 204；随后查询远程 D1，确认对应 `broadcast:manual:` 任务成功、事件成功且只有一次投递尝试。

- [ ] **步骤 5：推送并创建中文 PR**

  ```powershell
  git push -u origin codex/hourly-broadcast-manual-trigger
  ```

  创建非草稿中文 PR，标题概括“改为白天整点广播并支持手动发送”，正文使用中文说明规则、重复发送修复、手动入口安全性、测试和生产验证结果。
