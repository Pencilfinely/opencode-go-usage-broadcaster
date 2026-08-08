# PushPlus 内嵌用量图表实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将最近 24 小时用量图表直接渲染为 PushPlus 消息正文中的 24 行 Unicode 条形图，并移除新广播对 Browser Run 和 PushPlus 图片上传的依赖。

**Architecture:** 规则层从已经验证的 `UsageAggregate.buckets` 同步生成北京时间标签、十格条形条和精确 Token 数值；应用层把可用聚合直接交给消息渲染器并一次性写入 outbox。历史签名 SVG 路由、快照表和 30 天清理继续保留，只删除未部署且已证实无法鉴权的 PNG 上传链路。

**Tech Stack:** TypeScript 7、Cloudflare Workers、D1、Vitest 4、Wrangler 4。

## Global Constraints

- 所有新文案、提交、PR 标题、PR 正文和注释均使用中文。
- 自动广播保持北京时间 09:00–23:00 每小时一次，00:00–08:59 不发送；手动触发不受时间窗口限制。
- 图表固定使用 24 个现有小时桶，时区为 `Asia/Shanghai`，每条宽度固定十格。
- 非零小时实心格数为 `ceil(小时总 Token / 24 小时最大值 × 10)`，至少一格；零值显示十个 `░`。
- 图表正文不得包含 `<img>`、SVG、Canvas、远程字体或任何外部资源。
- 保留历史 `/charts/usage/*.svg`、`USAGE_CHART_SIGNING_SECRET`、D1 快照与 30 天清理。
- 测试仅覆盖与内嵌图表、应用简化和配置清理直接相关的关键路径，并执行现有完整回归。

---

### Task 1: 在规则层渲染内嵌条形图

**Files:**
- Modify: `src/usage-domain.ts:79-82`
- Modify: `src/rules.ts:190-253`
- Test: `test/rules.test.ts:20-45,154-193`

**Interfaces:**
- Consumes: `UsageAggregate`，其中 `buckets` 按时间顺序包含 24 个 `UsageHourBucket`。
- Produces: `renderInlineUsageChart(aggregate: UsageAggregate): string[]`；`UsageDetailsView` 的 available 分支只保留 `{ status: "available"; aggregate: UsageAggregate }`。

- [ ] **Step 1: 写入失败测试**

在 `test/rules.test.ts` 为 24 个北京时间小时桶构造数据，增加以下断言：

```ts
const startAt = Date.UTC(2026, 7, 7, 16); // 北京时间 08-08 00:00
const buckets = Array.from({ length: 24 }, (_, index) => ({
  startAt: startAt + index * 60 * 60 * 1000,
  inputTokens: index === 0 ? 100 : index === 1 ? 1 : 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0
}));
const message = renderBroadcastMessage(snapshot(49, 20, 10), "event-inline", true, {
  status: "available",
  aggregate: aggregate({ buckets })
});

expect(message.content).toContain("00时 ██████████ 100 Token");
expect(message.content).toContain("01时 █░░░░░░░░░ 1 Token");
expect(message.content).toContain("02时 ░░░░░░░░░░ 0 Token");
expect(message.content.match(/\d{2}时 [█░]{10} [\d,]+ Token/g)).toHaveLength(24);
expect(message.content).not.toContain("<img");
```

再增加全零桶用例，断言不会除零，24 行均为十个 `░`；保留模型名 HTML 转义与截断提示断言。

- [ ] **Step 2: 运行规则测试并确认 RED**

Run: `npx vitest run test/rules.test.ts`

Expected: FAIL；现有正文仍输出“图表暂不可用”或 `<img>`，找不到 `00时` 条形图。

- [ ] **Step 3: 实现最小规则层代码**

在 `src/usage-domain.ts` 删除 `chartUrl?: string`。在 `src/rules.ts` 增加：

```ts
const inlineHourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hourCycle: "h23"
});

export function renderInlineUsageChart(aggregate: UsageAggregate): string[] {
  const totals = aggregate.buckets.map((bucket) =>
    bucket.inputTokens + bucket.outputTokens +
    bucket.reasoningTokens + bucket.cacheTokens
  );
  const maximum = Math.max(0, ...totals);
  return aggregate.buckets.map((bucket, index) => {
    const total = totals[index] ?? 0;
    const filled = total === 0 || maximum === 0
      ? 0
      : Math.min(10, Math.max(1, Math.ceil(total / maximum * 10)));
    return inlineHourFormat.format(new Date(bucket.startAt)) + "时 " +
      "█".repeat(filled) + "░".repeat(10 - filled) + " " +
      formatInteger(total) + " Token";
  });
}
```

让 `renderUsageDetails` 在五行汇总之后加入标题“最近 24 小时每小时 Token：”和 `renderInlineUsageChart(aggregate)` 的结果；删除 `chartUrl`/`<img>`/“图表暂不可用”分支。截断提示继续位于图表之后。

- [ ] **Step 4: 运行规则测试并确认 GREEN**

Run: `npx vitest run test/rules.test.ts`

Expected: PASS；所有用量明细均无 `<img>`，24 行标签、比例和数值正确。

- [ ] **Step 5: 提交规则层**

```powershell
git add -- src/usage-domain.ts src/rules.ts test/rules.test.ts
git commit -m "功能：在消息中内嵌用量条形图"
```

### Task 2: 简化广播创建链路

**Files:**
- Modify: `src/app.ts:1-60,380-406,695-780`
- Test: `test/app.test.ts:145-600`

**Interfaces:**
- Consumes: Task 1 的 `UsageDetailsView`，可用分支为 `{ status: "available"; aggregate }`。
- Produces: `runBroadcast(trigger, env, deps)` 不再接受或构造 `chartImagePublisher`；可用明细直接固化为单个 daily outbox 事件。

- [ ] **Step 1: 将应用测试改成新行为并确认 RED**

从 `test/app.test.ts` 的 `AppDeps` 注入中删除所有 `chartImagePublisher` fake。把图片上传成功/失败/租约跨越测试收敛为以下关键断言：

```ts
const event = await env.DB.prepare(
  "SELECT content FROM outbox_events WHERE kind = 'daily'"
).first<{ content: string }>();

expect(event?.content).toContain("最近 24 小时每小时 Token");
expect(event?.content).toContain(" Token");
expect(event?.content).not.toContain("<img");
expect(event?.content).not.toContain("图表暂不可用");
```

保留并更新三类应用路径：完整 24 桶成功；明细 unavailable 时仍发送原因文案且无图表标题；同一手动幂等键重复调用只保留一个 daily 事件。图片发布失败与 Browser 耗时专用测试删除，因为对应生产阶段将不存在。

- [ ] **Step 2: 运行应用测试并确认 RED**

Run: `npx vitest run test/app.test.ts`

Expected: FAIL 或类型错误；`AppDeps` 与应用仍要求/执行图片发布路径。

- [ ] **Step 3: 删除图片发布阶段并直接创建最终事件**

在 `src/app.ts` 删除：

- `PushPlusImageError`、`uploadPushPlusPng`、`UsageChartPngError`、`renderUsageChartPng` 与 `UsageAggregate` 的图片专用导入。
- `AppDeps.chartImagePublisher`、`UsageChartImagePublisher` 类型及默认 Browser/上传实现。
- `isPushPlusPictureUrl` 及 `usage_chart_png_rendered`、`usage_chart_image_fallback` 日志。
- `textOnlyEvent → publish → richUsageView → targetEvent` 分支。

用单次事件创建替代：

```ts
const targetEvent = await newEvent(
  "daily",
  logicalKey,
  (eventId) => renderBroadcastMessage(snapshot, eventId, manual, usageView),
  notAfter,
  []
);
```

保留提交前的 `renewSnapshotLease`、`commitSnapshotUnderLease`、`usageChartSnapshots: []`、outbox 投递和手动触发结果判定。

- [ ] **Step 4: 运行应用与仓储回归并确认 GREEN**

Run: `npx vitest run test/app.test.ts test/repository.test.ts test/usage-chart.test.ts`

Expected: PASS；daily 事件只创建一次，历史 SVG 与快照仓储测试不变。

- [ ] **Step 5: 提交应用简化**

```powershell
git add -- src/app.ts test/app.test.ts
git commit -m "修复：移除广播图片上传阶段"
```

### Task 3: 删除无用模块与生产配置

**Files:**
- Delete: `src/pushplus-image.ts`
- Delete: `src/usage-chart-png.ts`
- Delete: `test/pushplus-image.test.ts`
- Delete: `test/usage-chart-png.test.ts`
- Modify: `src/config.ts:3-17,80-85,126-136`
- Modify: `test/config-source.test.ts:40-120,200-220`
- Modify: `wrangler.jsonc:6-10,29-35`
- Regenerate: `worker-configuration.d.ts`

**Interfaces:**
- Consumes: Task 2 已不再引用图片模块或 `env.BROWSER`。
- Produces: `AppConfig.pushplus` 仅包含发送所需的 `token`、`topic`、`callbackSecret` 与 `callbackBaseUrl`；生产 binding 不再包含 `BROWSER` 或 `PUSHPLUS_SECRET_KEY`。

- [ ] **Step 1: 先修改配置测试并确认 RED**

在 `test/config-source.test.ts` 先增加一个明确的遗留 binding 用例：

```ts
const config = loadConfig({
  ...validEnv(),
  PUSHPLUS_SECRET_KEY: "legacy-pushplus-secret-key-32-bytes-minimum"
} as Cloudflare.Env);
expect(config.pushplus).not.toHaveProperty("secretKey");
```

Run: `npx vitest run test/config-source.test.ts`

Expected: FAIL；当前 `loadConfig` 仍把已提供的 `PUSHPLUS_SECRET_KEY` 暴露为 `pushplus.secretKey`。

- [ ] **Step 2: 清理配置和模块**

从 `src/config.ts` 删除 `secretKey?: string`、Secret 长度校验与返回字段；从共享测试环境删除 `PUSHPLUS_SECRET_KEY` 及其缺失/过短专用测试；从 `wrangler.jsonc` 删除完整的 `browser` binding 和 required secrets 中的 `PUSHPLUS_SECRET_KEY`。精确删除四个只服务于失败方案的源文件/测试文件，然后运行：

```powershell
npm run typegen
```

确认生成的 `Cloudflare.Env` 仍包含 `DB` 与现有消息/回调/会话/历史 SVG bindings，但不包含 `BROWSER` 或 `PUSHPLUS_SECRET_KEY`。

- [ ] **Step 3: 运行配置、类型与定向测试并确认 GREEN**

Run: `npx vitest run test/config-source.test.ts test/rules.test.ts test/app.test.ts`

Run: `npm run typecheck`

Expected: 全部 PASS，TypeScript 中不存在图片模块、图片 publisher 或已删除 binding 的引用。

- [ ] **Step 4: 提交配置清理**

```powershell
git add -- src/config.ts test/config-source.test.ts wrangler.jsonc worker-configuration.d.ts
git add -u -- src/pushplus-image.ts src/usage-chart-png.ts test/pushplus-image.test.ts test/usage-chart-png.test.ts
git commit -m "清理：移除不可用的图片上传配置"
```

### Task 4: 完整验证并创建中文 PR

**Files:**
- Verify only: entire worktree

**Interfaces:**
- Consumes: Tasks 1–3 的三个提交。
- Produces: 可合并的中文 PR；不在 PR 合并前改动生产 Worker、PushPlus 开放接口或 Cloudflare Secret。

- [ ] **Step 1: 执行完整验证**

Run: `npm run check`

Run: `npx wrangler deploy --dry-run`

Run: `git diff --check master...HEAD`

Expected: 类型检查、Vitest、鉴权脚本与 dry-run 全部成功；dry-run bindings 中没有 `BROWSER`，required secrets 中没有 `PUSHPLUS_SECRET_KEY`。

- [ ] **Step 2: 审查变更范围**

Run: `git status --short`

Run: `git diff --stat master...HEAD`

Run: `git log --oneline master..HEAD`

Expected: 工作树干净；只包含规格、计划、规则/类型、应用测试、配置生成文件和四个图片模块删除，不改历史 SVG、D1 migration、调度或手动触发协议。

- [ ] **Step 3: 推送并创建 PR**

```powershell
git push -u origin codex/pushplus-inline-chart
gh pr create --base master --head codex/pushplus-inline-chart --title "修复 PushPlus 图表偶发无法显示" --body "根因：PushPlus 开放接口强制固定 IP 白名单，普通 Worker 无固定出口。改动：将 24 小时用量图表直接内嵌到消息正文，移除图片上传链路，并保留历史 SVG 兼容。验证：完整测试、鉴权测试、类型检查和 Wrangler dry-run 均通过。上线：合并后只触发一次手动冒烟。"
```

PR 正文必须为中文，包含：`403 IP未授权` 根因、内嵌条形图行为、历史 SVG 兼容、验证结果，以及“合并后只做一次手动冒烟”的上线说明。创建为可直接评审的非草稿 PR。

- [ ] **Step 4: 合并后的生产动作留待用户确认已合并**

合并后才执行 `wrangler deploy`、单次手动广播、PushPlus 页面验收、关闭开放接口和删除 `PUSHPLUS_SECRET_KEY`。任何一步失败都停止扩大变更，现有生产广播保持不动。
