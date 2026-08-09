# PushPlus 用量仪表盘重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 PushPlus 正文中的 Unicode 方块图改成用户确认的纯 HTML 仪表盘：顶部为三个精简额度条，底部保留完整的 24 小时精确 Token 数据。

**Architecture:** 新增一个无副作用的 `usage-dashboard-html` 渲染模块，只消费规则层已经拥有的额度视图和 `UsageDetailsView`，同步输出富样式表格或确定性的兼容版表格。`rules.ts` 继续决定消息标题、测试数据标识和北京时间文本；应用、仓储、PushPlus 发送、定时和历史 SVG 链路均保持不变。

**Tech Stack:** TypeScript 7、Cloudflare Workers、Vitest 4、Wrangler 4、PushPlus HTML 模板。

## Global Constraints

- 所有新增文案、代码注释、提交、PR 标题和 PR 正文使用中文；技术标识符保持既有命名风格。
- 新正文不得包含图片、外部 URL、远程字体、SVG、Canvas、JavaScript、`<style>`、flex、grid 或定位布局。
- 核心布局只使用嵌套的 `<table>`、`<tr>`、`<td>` 和内联样式；重要底色同时写 `bgcolor` 与 `background-color`。
- 顶部固定显示 5 小时、每周、每月三个额度条、百分比和各自的完整重置时间。
- 用量可用时固定显示三个汇总指标、24 根趋势柱、四类 Token、24 个未缩写小时值以及模型排行。
- 用量不可用时只显示既有原因文案，不生成空汇总、空趋势图或空模型表；三个额度条仍正常显示。
- 24 小时主柱高度上限为 88 像素；零值为 0，非零值按四类 Token 总和四舍五入并至少显示 3 像素。
- 精确值默认使用两列各 12 行；任一千分位整数超过 10 个字符时切换为单列 24 行，不能截断或缩写。
- 模型展示名最终最多 64 个 Unicode 码点；超长名称使用前 63 个码点加 `…`，然后进行 HTML 转义。
- 富样式正文安全预算为 18,000 个 JavaScript 字符；超限时改用保留全部数据的兼容版，兼容版仍超限才抛出 `RangeError`。
- 不修改 `src/usage-domain.ts`、`src/app.ts`、`src/repository.ts`、`src/pushplus.ts`、`wrangler.jsonc`、D1 migration、Cron 或手动触发协议。
- 历史 `/charts/usage/*.svg` 路由、签名配置、快照表和 30 天清理继续保留。
- PR 合并前不部署生产 Worker、不触发真实广播；合并后只允许一次手动冒烟。

## 文件与职责映射

| 文件 | 职责 |
|---|---|
| `src/usage-dashboard-html.ts` | 新增纯函数渲染器，负责安全 HTML、图表比例、精确值布局、模型展示和正文预算降级 |
| `test/usage-dashboard-html.test.ts` | 新增渲染器定向测试，覆盖结构、数值、降级和安全边界 |
| `src/rules.ts:152-265,329-363` | 删除旧 Unicode/`<br>` 明细渲染，把现有消息入口接到新模块 |
| `test/rules.test.ts:10-45,153-214` | 保留规则入口集成测试，以结构与语义断言替换 Unicode 外观断言 |
| `README.md:3-17,67-91` | 将新广播说明改成纯 HTML 仪表盘，保留历史 SVG 兼容说明 |

---

### 任务 1：建立安全的仪表盘外壳和额度区域

**文件：**
- 新建：`src/usage-dashboard-html.ts`
- 新建：`test/usage-dashboard-html.test.ts`

**接口：**

```ts
import type { WindowKey } from "./domain";
import type { UsageDetailsView } from "./usage-domain";

export const DASHBOARD_CONTENT_BUDGET = 18_000;

export interface DashboardQuotaRow {
  key: WindowKey;
  label: string;
  usedPercent: number;
  resetText: string;
}

export interface UsageDashboardInput {
  testData: boolean;
  statusLabel: "整点用量" | "手动用量";
  observedAtText: string;
  quotaRows: readonly DashboardQuotaRow[];
  usageDetails: UsageDetailsView;
  eventId: string;
}

export interface UsageDashboardRenderOptions {
  contentBudget?: number;
}

export function renderUsageDashboardHtml(
  input: UsageDashboardInput,
  options?: UsageDashboardRenderOptions
): string;
```

新模块只导入 `domain.ts` 和 `usage-domain.ts`；`rules.ts` 单向导入新模块，因此依赖方向保持为 `app.ts → rules.ts → usage-dashboard-html.ts`，不会形成循环。

- [ ] **步骤 1：写入额度和不可用状态的失败测试**

在 `test/usage-dashboard-html.test.ts` 创建三条不同额度和三个不同重置时间的夹具：

```ts
const quotaRows: DashboardQuotaRow[] = [
  { key: "rolling", label: "5 小时额度", usedPercent: 49, resetText: "08月03日 14:00" },
  { key: "weekly", label: "每周额度", usedPercent: 20, resetText: "08月09日 08:00" },
  { key: "monthly", label: "每月额度", usedPercent: 10, resetText: "09月01日 08:00" }
];

const content = renderUsageDashboardHtml({
  testData: true,
  statusLabel: "手动用量",
  observedAtText: "08月03日 09:00",
  quotaRows,
  usageDetails: { status: "unavailable", reason: "not-authorized" },
  eventId: "event<quota>"
});
```

断言：

```ts
expect(content).toContain("【测试数据】OpenCode Go 手动用量");
expect(content).toContain("08月03日 09:00");
expect(content.match(/data-quota=/g)).toHaveLength(3);
expect(content).toMatch(/data-quota-progress="rolling"[^>]*width="49%"/);
expect(content).toMatch(/data-quota-progress="weekly"[^>]*width="20%"/);
expect(content).toMatch(/data-quota-progress="monthly"[^>]*width="10%"/);
expect(content).toContain("24 小时明细尚未授权");
expect(content).toContain("event&lt;quota&gt;");
expect(content).not.toContain("event<quota>");
expect(content).not.toContain('data-section="summary"');
expect(content).not.toContain('data-section="hourly-chart"');
expect(content).not.toContain('data-section="token-breakdown"');
expect(content).not.toContain('data-section="hourly-exact"');
expect(content).not.toContain('data-section="models"');
```

同时断言轨道和填充单元格均同时具有 `bgcolor` 与同色的内联 `background-color`，根布局为 `width="100%"` 的展示表格。

- [ ] **步骤 2：运行新测试并确认失败**

运行：`npx vitest run test/usage-dashboard-html.test.ts`

预期：失败；新模块尚不存在，Vitest 报模块解析失败。

- [ ] **步骤 3：实现最小安全外壳**

在新模块中实现以下基础函数，并让 unavailable 分支生成标题、三个额度行、原因文案和完整页脚：

```ts
function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function progressPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

type DashboardVariant = "rich" | "compatibility";

function renderDashboardVariant(
  input: UsageDashboardInput,
  variant: DashboardVariant
): string;
```

额度行必须输出稳定的 `data-quota="rolling|weekly|monthly"` 标记，对应填充单元格输出 `data-quota-progress`；百分比文字和 `width="N%"` 均使用同一个已夹紧数值。填充色固定为 `#2563eb`，轨道色固定为 `#e5e7eb`；颜色单元格同时输出 `bgcolor` 和 `style="background-color:..."`。正文头部使用 `testData` 决定是否显示 `【测试数据】`，不接受可执行 HTML 片段。

不可用原因沿用现有五种中文文案；页脚始终包含观察时间、“当前小时为部分小时，仅统计至观察时间。”和经过转义的完整事件号。

- [ ] **步骤 4：运行新测试并确认通过**

运行：`npx vitest run test/usage-dashboard-html.test.ts`

预期：通过；三个额度行、不同重置时间、不可用文案和事件转义均正确。

- [ ] **步骤 5：提交仪表盘外壳**

```powershell
git add -- src/usage-dashboard-html.ts test/usage-dashboard-html.test.ts
git commit -m "功能：建立 PushPlus 仪表盘外壳"
```

### 任务 2：渲染完整用量仪表盘和确定性兼容版

**文件：**
- 修改：`src/usage-dashboard-html.ts`
- 修改：`test/usage-dashboard-html.test.ts`

**接口：**
- 输入：`UsageDetailsView` 的 available 分支及其现有 `UsageAggregate`；聚合器已保证 24 个连续北京时间小时桶和前五模型加“其他”的顺序。
- 输出：默认不超过 `DASHBOARD_CONTENT_BUDGET` 的富样式或兼容版 HTML；不返回外部 URL，也不修改输入聚合。

- [ ] **步骤 1：写入完整数据、零值和安全边界的失败测试**

新增 `hourlyBuckets(values: readonly number[])`，从 `Date.UTC(2026, 7, 7, 16)` 开始生成北京时间 00–23 时的 24 个桶。用峰值 100、极小非零值 1 和其余零值构造完整 available 输入，断言：

```ts
expect(content).toContain('data-dashboard-variant="rich"');
expect(content.match(/data-hour-bar=/g)).toHaveLength(24);
expect(content).toMatch(/data-hour-bar="00"[^>]*height:88px/);
expect(content).toMatch(/data-hour-bar="01"[^>]*height:3px/);
expect(content).toMatch(/data-hour-bar="02"[^>]*height:0/);
expect(content).toContain("最近 24 小时请求数");
expect(content).toContain("总 Token");
expect(content).toContain("费用");
expect(content).toContain("输入");
expect(content).toContain("输出");
expect(content).toContain("推理");
expect(content).toContain("缓存");
expect(content).toContain('data-hour-layout="double"');
expect(content.match(/data-hour-value=/g)).toHaveLength(24);
```

每个小时项目把 `data-hour-value="HH"` 放在包住该小时标签、迷你横条和精确数值的同一个嵌套表格上。提取全部 24 个属性，断言第 `index` 行的两个属性依次为补零后的 `index` 和 `index + 12`（`index` 为 0–11），从而同时证明左列为 00–11、右列为 12–23，且没有重复或缺失；再分别断言 `00→100`、`01→1`、`02→0` 的同一小时项目内映射正确。

让 00 时峰值由输入 40、输出 30、推理 20、缓存 10 组成，01 时只有 1 个输入 Token；逐项断言汇总值和 `$1.2346` 费用口径。模型夹具包含五个模型和“其他”，断言六行顺序、Token 与一位小数占比。

再加入全零 available 输入，断言请求数、总 Token、费用均显示 0，24 根柱均为零高、24 个精确值均为 `0`，并显示“暂无模型记录”。

集中加入正文安全断言：

```ts
expect(content).not.toMatch(/<(?:img|svg|canvas|script|style)\b/i);
expect(content).not.toMatch(/display\s*:\s*(?:flex|grid)|position\s*:/i);
expect(content).not.toMatch(/[█░]/);

const realTags = content.match(/<[^>]+>/g)?.join("") ?? "";
expect(realTags).not.toMatch(/\b(?:src|href)\s*=/i);
expect(realTags).not.toMatch(/url\s*\(/i);
```

不要对整段文本直接禁止 `https://`、`src=` 或 `href=`：这些字符可以合法出现在已经转义的模型名或事件号中。只检查真实 HTML 标签，才能验证“不会加载外部资源”而不误报普通文本。

- [ ] **步骤 2：写入长数值、模型名、截断和预算降级的失败测试**

使用 `Number.MAX_SAFE_INTEGER` 作为每个小时的唯一输入 Token，断言完整文本 `9,007,199,254,740,991` 未缩写，并出现 `data-hour-layout="single"`。提取单列的 24 个 `data-hour-value`，断言严格等于 00 至 23 的顺序。模型名分别使用恰好 64 个码点、65 个码点和 `<img src=x>`，断言：恰好 64 个码点的不变；65 个码点显示前 63 个加 `…`；标签文本被转义，未出现真实 `<img>`。

对 `truncated: true` 断言请求数、Token、费用和模型数据继续带“至少”，页脚继续显示“仅含已采集的最新记录”。

验证默认预算和强制兼容版：

```ts
const rich = renderUsageDashboardHtml(input, {
  contentBudget: Number.MAX_SAFE_INTEGER
});
expect(rich).toContain('data-dashboard-variant="rich"');

const compatible = renderUsageDashboardHtml(input, {
  contentBudget: rich.length - 1
});
expect(compatible).toContain('data-dashboard-variant="compatibility"');
expect(compatible).not.toContain('data-section="hourly-chart"');
expect(compatible).not.toContain("data-mini-bar=");
expect(compatible.match(/data-hour-value=/g)).toHaveLength(24);
expect(compatible).toContain("9,007,199,254,740,991");
expect(compatible).toContain("事件：event-budget");

const production = renderUsageDashboardHtml(input);
expect(production.length).toBeLessThanOrEqual(DASHBOARD_CONTENT_BUDGET);
expect(() => renderUsageDashboardHtml(input, { contentBudget: 1 }))
  .toThrow(RangeError);
```

- [ ] **步骤 3：运行新测试并确认失败**

运行：`npx vitest run test/usage-dashboard-html.test.ts`

预期：失败；available 分支尚未生成汇总、趋势、精确值、模型表或兼容版。

- [ ] **步骤 4：实现比例、格式化和模型安全辅助函数**

按以下口径实现纯函数：

```ts
const integerFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0
});

const hourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hourCycle: "h23"
});

function bucketTotal(bucket: UsageHourBucket): number {
  return bucket.inputTokens + bucket.outputTokens +
    bucket.reasoningTokens + bucket.cacheTokens;
}

function barHeight(total: number, maximum: number): number {
  if (total === 0 || maximum === 0) return 0;
  return Math.min(88, Math.max(3, Math.round(total / maximum * 88)));
}

function miniBarPercent(total: number, maximum: number): number {
  if (total === 0 || maximum === 0) return 0;
  return Math.min(100, Math.max(1, Math.round(total / maximum * 100)));
}

function modelDisplayName(value: string): string {
  const codePoints = Array.from(value);
  const display = codePoints.length <= 64
    ? value
    : codePoints.slice(0, 63).join("") + "…";
  return escapeHtmlText(display);
}
```

所有汇总和小时数值使用 `integerFormat`；费用继续使用 `"$" + (costMicroCents / 100000000).toFixed(4)`。`truncated` 为真时，对请求数、总 Token、四类 Token、费用、模型 Token 和模型占比沿用“至少”前缀。

- [ ] **步骤 5：实现富样式表格**

在 rich 变体中依次输出以下稳定区段：

1. `data-section="summary"`：三列请求数、总 Token、费用；
2. `data-section="hourly-chart"`：24 个 `data-hour-bar="00"` 至 `"23"` 的竖柱；
3. `data-section="token-breakdown"`：输入、输出、推理、缓存 2×2 表格；
4. `data-section="hourly-exact"`：24 个 `data-hour-value` 和对应 `data-mini-bar`；
5. `data-section="models"`：模型名、Token、占比逐行表格，或“暂无模型记录”。

主柱固定处于 88 像素高的底部对齐单元格中；把 `data-hour-bar`、高度样式、`bgcolor="#2563eb"` 与相同 `background-color` 写在同一个填充单元格上，确保结构和测试一一对应。图表只显示少量时间刻度；所有 24 个小时标签和值仍由精确表完整承担。

精确表先生成 24 个 `{ hour, rawValue, displayValue, miniPercent }`。只要任一 `rawValue` 的千分位字符串长度大于 10，就输出 `data-hour-layout="single"` 的 24 行；否则输出 `data-hour-layout="double"` 的 12 行，每行左侧为索引 `0..11`，右侧为索引 `12..23`。任何布局都不得缩写数字。

- [ ] **步骤 6：实现 18,000 字符预算和兼容版**

兼容版保留头部、三个额度、全部汇总、四类 Token、24 个精确值、模型排行、截断提示和页脚；移除主柱图、24 个迷你横条及装饰性边框。根表格输出 `data-dashboard-variant` 供定向测试，不依赖该属性实现视觉效果。

```ts
export function renderUsageDashboardHtml(
  input: UsageDashboardInput,
  options: UsageDashboardRenderOptions = {}
): string {
  const budget = options.contentBudget ?? DASHBOARD_CONTENT_BUDGET;
  const rich = renderDashboardVariant(input, "rich");
  if (rich.length <= budget) return rich;

  const compatibility = renderDashboardVariant(input, "compatibility");
  if (compatibility.length <= budget) return compatibility;

  throw new RangeError(
    `PushPlus 仪表盘正文超过 ${budget} 字符安全预算`
  );
}
```

- [ ] **步骤 7：运行渲染器测试并确认通过**

运行：`npx vitest run test/usage-dashboard-html.test.ts`

预期：通过；正常夹具使用 rich 变体且不超过 18,000 字符，长值切为单列，强制预算切换后仍保留全部数据。

- [ ] **步骤 8：提交完整仪表盘渲染器**

```powershell
git add -- src/usage-dashboard-html.ts test/usage-dashboard-html.test.ts
git commit -m "功能：渲染完整用量仪表盘"
```

### 任务 3：接入广播规则并更新使用说明

**文件：**
- 修改：`src/rules.ts:1-12,152-265,329-363`
- 修改：`test/rules.test.ts:10-45,153-214`
- 修改：`README.md:3-17,67-91`

**接口：**
- 输入：任务 2 的 `renderUsageDashboardHtml(input)`。
- 输出：`renderBroadcastMessage(snapshot, eventId, manual, usageDetails)` 参数、返回类型和标题规则均保持不变，仅替换 `content` 的展示实现。

- [ ] **步骤 1：将规则入口测试改成新结构并确认失败**

保留 `test/rules.test.ts:47-151` 的阈值规则测试不动。给 `snapshot()` 增加可选的三个独立重置时间，增加 `hourlyBuckets()` 夹具，并将 153–214 行收敛成两条入口测试：

1. available 手动消息：标题仍为 `【测试数据】OpenCode Go 手动用量`，正文含三个额度、rich 仪表盘、24 根柱、24 个精确值、观察时间和完整事件号；不含 Unicode 方块或外部资源。
2. unavailable 消息：三个额度仍存在，含对应原因文案，但不含 summary、hourly-chart、token-breakdown、hourly-exact 和 models 五个 available 专属区段。

运行：`npx vitest run test/rules.test.ts`

预期：失败；当前入口仍输出 `<br>` 和 Unicode 条形图。

- [ ] **步骤 2：用新模块替换旧广播正文渲染**

在 `src/rules.ts` 导入新模块，只保留规则层仍需的 `UsageDetailsView` 类型。删除只服务旧正文的 `escapeHtmlText`、`USAGE_UNAVAILABLE_COPY`、数字/小时格式化、`renderInlineUsageChart`、`formatQualified`、`formatModels` 和 `renderUsageDetails`。

将 `renderBroadcastMessage` 改为：

```ts
export function renderBroadcastMessage(
  snapshot: QuotaSnapshot,
  eventId: string,
  manual: boolean,
  usageDetails: UsageDetailsView = {
    status: "unavailable",
    reason: "not-authorized"
  }
): RenderedMessage {
  const quotaRows = WINDOW_KEYS.map((key) => ({
    key,
    label: WINDOW_LABELS[key],
    usedPercent: snapshot.windows[key].usedPercent,
    resetText: formatReset(snapshot.windows[key].resetAt)
  }));
  const statusLabel = manual ? "手动用量" : "整点用量";

  return {
    title: prefix(snapshot) + "OpenCode Go " + statusLabel,
    content: renderUsageDashboardHtml({
      testData: snapshot.source === "fixture",
      statusLabel,
      observedAtText: formatReset(snapshot.observedAt),
      quotaRows,
      usageDetails,
      eventId
    })
  };
}
```

不得改变阈值、每日汇总、启动或故障消息的现有格式，也不得改动 `UsageDetailsView` 或聚合器。

- [ ] **步骤 3：运行规则与渲染器测试并确认通过**

运行：`npx vitest run test/usage-dashboard-html.test.ts test/rules.test.ts`

预期：通过；广播入口已使用仪表盘，其他规则消息测试保持通过。

- [ ] **步骤 4：更新 README 的当前广播说明**

按以下位置修改：

- 第 3 行：将 Unicode 条形图改为不依赖图片或外部资源的纯 HTML 仪表盘。
- 第 7–17 行：将“各行换行分隔”重写为六个区域：状态与观察时间、三个额度条、三个汇总、24 小时趋势与四类 Token、完整 24 小时精确值、模型排行与元信息。
- 同段说明模型前五加“其他”、18,000 字符预算，以及兼容版不会删除精确数据。
- 第 69 行：明确新广播不生成图片或新的 SVG 链接；后续历史 SVG 配置和访问范围保持不变。
- 第 86 行：改为 PushPlus 详情页和微信打开页的真实烟测等待合并部署后进行，不再提图片烟测。
- 第 91 行：明确纯 HTML 仪表盘仍是可降级附加内容，不影响三项额度和既有时段。

- [ ] **步骤 5：检查活动代码和说明中没有旧展示残留**

运行：`rg -n "renderInlineUsageChart|[█░]|正文中的 Unicode|新广播只在正文输出 Unicode" src README.md`

预期：活动源码和 README 无匹配。测试中的禁止项正则、历史设计文档中的旧决策记录不纳入该扫描。

- [ ] **步骤 6：提交规则接入和说明**

```powershell
git add -- src/rules.ts test/rules.test.ts README.md
git commit -m "功能：接入 PushPlus 用量仪表盘"
```

### 任务 4：完整验证、审查并创建中文 PR

**文件：**
- 验证：整个隔离工作树
- 只有审查在任务 1–3 所列文件中发现可复现缺陷时才修改对应文件

**接口：**
- 输入：任务 1–3 的三个实现提交，以及已提交的设计规格和本实施计划。
- 输出：一条可评审的中文 PR；生产 Worker 和真实广播保持不动。

- [ ] **步骤 1：执行完整本地验证**

运行：`npm run check`

运行：`npx wrangler deploy --dry-run`

运行：`git diff --check master...HEAD`

预期：TypeScript、Vitest、授权脚本和 Wrangler dry-run 全部通过；没有格式错误或新 binding。

- [ ] **步骤 2：审查变更范围和正文安全属性**

运行：`git status --short`

运行：`git diff --name-only master...HEAD`

运行：`git diff --stat master...HEAD`

预期：工作树干净；实现范围只有设计/计划文档、`README.md`、新渲染器及测试、`rules.ts` 和规则测试。`src/app.ts`、`src/repository.ts`、`src/pushplus.ts`、`src/usage-domain.ts`、`wrangler.jsonc` 与 migrations 无差异。

再次运行：

`rg -n "<(img|svg|canvas|script|style)\\b|https?://|display\\s*:\\s*(flex|grid)|position\\s*:|[█░]" src/usage-dashboard-html.ts test/usage-dashboard-html.test.ts src/rules.ts test/rules.test.ts`

预期：只允许测试中的禁止项正则本身命中；生产渲染字符串不得命中。

- [ ] **步骤 3：请求独立代码审查并修复已证实问题**

使用 `superpowers:requesting-code-review` 对照设计规格检查：数据完整性、HTML 转义、64 码点限制、柱高、双列转单列、18,000 字符预算、兼容版完整性和未授权降级。若发现问题，先增加能复现的失败测试，再做最小修复，并重新执行步骤 1 的验证；所有审查与修复说明使用中文。

- [ ] **步骤 4：推送分支并创建中文非草稿 PR**

```powershell
git push -u origin codex/pushplus-dashboard-redesign
gh pr create --base master --head codex/pushplus-dashboard-redesign --title "优化 PushPlus 用量仪表盘展示" --body "本次把新广播中的 Unicode 方块图替换为纯 HTML 仪表盘：顶部显示三个精简额度条，正文保留 24 小时趋势、四类 Token、完整精确值和模型排行；富样式超出 18,000 字符时会切换为不丢数据的兼容表格。未改采集、定时、手动触发、outbox、发送和历史 SVG 链路。验证结果以本次实际执行的类型检查、测试、鉴权测试和 Wrangler dry-run 为准。合并前不部署生产；合并后只手动触发一次冒烟。"
```

- [ ] **步骤 5：合并后的生产动作留待用户明确确认**

用户确认 PR 已合并后，才从最新 `master` 运行完整检查、部署 Worker，并通过现有 GitHub Actions 只触发一次手动广播。验收 PushPlus 详情页和微信打开页的三个额度条、24 根柱、完整精确值、无横向滚动、无外部资源请求，以及 D1 中该事件只创建和投递一次；不得为观察外观重复发送。
