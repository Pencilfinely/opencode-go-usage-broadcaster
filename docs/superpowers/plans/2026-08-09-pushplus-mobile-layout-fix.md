# PushPlus 仪表盘移动端布局修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PushPlus 仪表盘改为对手机竖屏和字体放大稳定的纵向布局：额度条独占整行，24 小时精确值固定单列并保留每小时全宽迷你条。

**Architecture:** 继续由 `usage-dashboard-html.ts` 纯同步渲染完整正文，不增加前端脚本、设备检测或新依赖。只改变额度区和每小时精确值区的表格层级，让可变文字与可压缩条形不再竞争同一横向空间；富版保留迷你条，兼容版保留全部精确值但移除装饰条。

**Tech Stack:** TypeScript、Cloudflare Workers、Vitest、PushPlus 纯内联 HTML、Wrangler 4。

## Global Constraints

- 所有 PR 标题、PR 正文、测试名、提交信息、审查和注释必须使用中文；技术标识符可保留英文。
- 不增加运行时或测试依赖，不使用 DOM 模拟器、截图测试或媒体查询。
- 正文不得包含图片、外部 URL、远程字体、SVG、Canvas、JavaScript、`<style>`、flex、grid 或定位布局。
- 富版保留 24 个每小时迷你条；兼容版可以移除迷你条，但必须保留 24 个完整精确数值。
- 动态 Token 数值不得截断或缩写；字体放大时只允许在自己的数值单元格内换行。
- 正文安全预算固定为 18,000 字符；兼容版仍超预算时继续抛出 `RangeError`。
- 不修改采集、聚合、定时、手动触发、幂等、outbox、PushPlus 发送、回调、D1 迁移或历史 SVG 路由。
- 合并前不得部署或发送真实广播；合并后只允许一次手动生产烟测。

## File Structure

| 文件 | 职责与本次改动 |
| --- | --- |
| `src/usage-dashboard-html.ts` | 保持唯一的纯 HTML 渲染边界；重构额度块和精确小时块的表格结构 |
| `test/usage-dashboard-html.test.ts` | 先以失败测试锁定移动端语义结构，再覆盖零值、长值、预算和安全边界 |
| `test/app.test.ts` | 将旧的 `40% + nowrap` 正文断言改成移动端单列语义断言，不削弱应用状态与投递断言 |
| `README.md` | 说明额度条上下分行、24 小时固定单列和富版迷你条行为 |

---

### Task 1: 让每项额度的进度条独占整行

**Files:**
- Modify: `test/usage-dashboard-html.test.ts:102-210`
- Modify: `src/usage-dashboard-html.ts:199-234`

**Interfaces:**
- Consumes: `DashboardQuotaRow` 和现有 `renderUsageDashboardHtml(input, options)`。
- Produces: 保持 `renderUsageDashboardHtml` 签名不变；每项额度输出 `data-quota`、`data-quota-meta`、`data-quota-bar-row`，并保留既有进度、剩余、百分比和重置时间标记。

- [ ] **Step 1: 写入会暴露同排挤压问题的失败测试**

先把 `quotaItem` 的起点改为独立额度表格的开标签；最后一项仍以额度父表的 `</tbody>` 为边界：

```ts
function quotaItem(content: string, key: DashboardQuotaRow["key"]): string {
  const marker = `<table data-quota="${key}"`;
  const start = content.indexOf(marker);
  const nextQuota = content.indexOf("<table data-quota=", start + marker.length);
  const end = nextQuota === -1 ? content.indexOf("</tbody>", start) : nextQuota;
  return content.slice(start, end === -1 ? content.length : end);
}
```

然后新增：

```ts
it("每项额度的进度条独占下一整行，不与文字和百分比争抢宽度", () => {
  const content = renderUsageDashboardHtml(
    availableInput(completeAggregate())
  );
  const rolling = quotaItem(content, "rolling");

  expect(rolling).toMatch(
    /<table data-quota="rolling"[^>]*>[\s\S]*?<tr data-quota-meta="rolling">/
  );
  expect(rolling).toMatch(
    /<tr data-quota-bar-row="rolling"><td colspan="2" data-quota-track="rolling"/
  );

  const meta = rolling.match(
    /<tr data-quota-meta="rolling">[\s\S]*?<\/tr>/
  )?.[0] ?? "";
  const bar = rolling.match(
    /<tr data-quota-bar-row="rolling">[\s\S]*?<\/tr>/
  )?.[0] ?? "";

  expect(meta).toContain("5 小时额度");
  expect(meta).toContain('data-quota-reset="rolling"');
  expect(meta).toContain('data-quota-percent="rolling"');
  expect(meta).not.toContain('data-quota-track="rolling"');
  expect(bar).toContain('data-quota-track="rolling"');
  expect(bar).not.toContain('data-quota-percent="rolling"');
  expect(bar).not.toContain('data-quota-reset="rolling"');
});
```

同时把零、满格测试的取段方式改为从独立 `data-quota` 表格提取，继续断言 0% 无蓝色填充、100% 无剩余格、50% 为互补两格。

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run:

```powershell
npx vitest run test/usage-dashboard-html.test.ts
```

Expected: 新测试失败，因为当前 `data-quota` 是同一行三列，正文不存在 `data-quota-meta`、`data-quota-bar-row` 或 `colspan="2"`。

- [ ] **Step 3: 最小重构额度块 HTML**

将 `renderQuotaRow` 改为返回独立额度表格。核心结构必须等价于：

```ts
function renderQuotaRow(row: DashboardQuotaRow): string {
  const percent = progressPercent(row.usedPercent);
  const progress = String(percent) + "%";
  const remaining = String(100 - percent) + "%";
  const key = escapeHtmlText(row.key);
  const fill = percent === 0
    ? ""
    : `<td data-quota-progress="${key}" width="${progress}" bgcolor="#2563eb" style="background-color:#2563eb"></td>`;
  const rest = percent === 100
    ? ""
    : `<td data-quota-remaining="${key}" width="${remaining}" bgcolor="#e5e7eb" style="background-color:#e5e7eb"></td>`;

  return `<tr><td><table data-quota="${key}" width="100%" role="presentation" cellspacing="0" cellpadding="6"><tr data-quota-meta="${key}"><td>${escapeHtmlText(row.label)}<br><span data-quota-reset="${key}" style="color:#6b7280;font-size:12px">重置：${escapeHtmlText(row.resetText)}</span></td><td data-quota-percent="${key}" align="right" nowrap style="white-space:nowrap">${progress}</td></tr><tr data-quota-bar-row="${key}"><td colspan="2" data-quota-track="${key}" bgcolor="#e5e7eb" style="background-color:#e5e7eb"><table width="100%" height="8" role="presentation" cellspacing="0" cellpadding="0"><tr>${fill}${rest}</tr></table></td></tr></table></td></tr>`;
}
```

`renderDashboardVariant` 继续使用既有额度父表和 `<tbody>${quotaRows}</tbody>`；每个父表直接行现在只包住一个独立额度表格。

- [ ] **Step 4: 运行聚焦测试并确认 GREEN**

Run:

```powershell
npx vitest run test/usage-dashboard-html.test.ts
```

Expected: 额度新测试通过；0%、50%、100%、背景色、转义和不可用状态测试继续通过。

- [ ] **Step 5: 提交额度移动端结构**

```powershell
git add -- src/usage-dashboard-html.ts test/usage-dashboard-html.test.ts
git diff --cached --check
git commit -m "修复：让额度进度条独占整行"
```

---

### Task 2: 将 24 小时精确值固定为单列并保留全宽迷你条

**Files:**
- Modify: `test/usage-dashboard-html.test.ts:8-98, 151-407`
- Modify: `test/app.test.ts:375-389`
- Modify: `src/usage-dashboard-html.ts:151-176`

**Interfaces:**
- Consumes: `hourlyValues(aggregate)` 返回的 24 个 `HourValue` 和 `DashboardVariant`。
- Produces: `renderHourlyExact` 固定输出 `data-hour-layout="single"`；每个小时的直接外层行使用 `data-hour-row="HH"`，富版迷你条行使用 `data-mini-bar-row="HH"`。

- [ ] **Step 1: 将普通数据双列预期改为失败的单列结构预期**

删除 `DOUBLE_HOUR_ORDER`，统一使用真实顺序常量：

```ts
const HOUR_ORDER = [
  "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
  "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23"
];
```

新增或改写测试：

```ts
it("普通长度的 24 小时精确值也逐小时独占单列", () => {
  const content = renderUsageDashboardHtml(
    availableInput(completeAggregate())
  );
  const hours = [...content.matchAll(/data-hour-row="(\d{2})"/g)]
    .map((match) => match[1]);

  expect(content).toContain('data-hour-layout="single"');
  expect(hours).toEqual(HOUR_ORDER);
  expect(content.match(/data-hour-row=/g)).toHaveLength(24);
  expect(content).not.toContain('data-hour-layout="double"');

  for (const hour of HOUR_ORDER) {
    const item = hourItem(content, hour);
    expect(item).toContain(`data-mini-bar-row="${hour}"`);
    expect(item).toMatch(/<td colspan="2">[\s\S]*?data-mini-bar=/);
  }
});

it("精确数值允许只在自身单元格内换行", () => {
  const content = renderUsageDashboardHtml(
    availableInput(completeAggregate())
  );
  const firstHour = hourItem(content, "00");

  expect(firstHour).toMatch(
    /<td[^>]*align="right"[^>]*style="[^"]*white-space:normal[^"]*"[^>]*>100<\/td>/
  );
  expect(firstHour).not.toMatch(/align="right"[^>]*nowrap/);
});
```

把全零、跨日和最大安全整数测试的小时顺序统一改为 `HOUR_ORDER` 或夹具对应的真实 24 小时顺序；兼容版必须断言 24 个 `data-hour-row` 且不存在 `data-mini-bar-row`。

同时把 `test/app.test.ts` 中旧的 `width="40%" align="right" nowrap` 断言替换为：

```ts
expect(event).not.toBeNull();
expect(event?.content.match(/data-hour-row="\d{2}"/g))
  .toHaveLength(24);
expect(event?.content.match(/data-mini-bar-row="\d{2}"/g))
  .toHaveLength(24);
expect(event?.content).toContain('data-hour-layout="single"');
expect(event?.content).toMatch(
  /data-hour-meta="\d{2}"[\s\S]*?<td width="70%" align="right"[^>]*white-space:normal[^>]*>0<\/td>/
);
expect(event?.content).not.toMatch(/align="right"[^>]*nowrap>0<\/td>/);
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run:

```powershell
npx vitest run test/usage-dashboard-html.test.ts test/app.test.ts
```

Expected: 普通输入仍输出 `data-hour-layout="double"`、顺序为 00/12 交错、迷你条与数值处于同一行且数值带 `nowrap`，因此渲染器与应用的新断言都失败。

- [ ] **Step 3: 最小重构每小时项目与精确值表**

将 `renderHourValue` 改为“数值行 + 可选全宽迷你条行”：

```ts
function renderHourValue(value: HourValue, includeMiniBar: boolean): string {
  const fillStyle = value.miniPercent === 0
    ? ""
    : ' bgcolor="#2563eb" style="background-color:#2563eb"';
  const remainingPercent = 100 - value.miniPercent;
  const miniBar = `<table data-mini-bar="${value.hour}" width="100%" height="6" cellspacing="0" cellpadding="0" bgcolor="#e5e7eb" style="background-color:#e5e7eb"><tr><td width="${value.miniPercent}%"${fillStyle}></td><td width="${remainingPercent}%"></td></tr></table>`;
  const miniBarRow = includeMiniBar
    ? `<tr data-mini-bar-row="${value.hour}"><td colspan="2">${miniBar}</td></tr>`
    : "";

  return `<table data-hour-value="${value.hour}" width="100%" role="presentation" cellspacing="0" cellpadding="2"><tr data-hour-meta="${value.hour}"><td width="30%" nowrap>${value.hour} 时</td><td width="70%" align="right" style="text-align:right;white-space:normal;word-break:break-all">${value.displayValue}</td></tr>${miniBarRow}</table>`;
}
```

将 `renderHourlyExact` 固定为 24 个直接单列行：

```ts
function renderHourlyExact(
  aggregate: UsageAggregate,
  variant: DashboardVariant
): string {
  const values = hourlyValues(aggregate);
  const includeMiniBar = variant === "rich";
  const rows = values.map((value) =>
    `<tr data-hour-row="${value.hour}"><td>${renderHourValue(value, includeMiniBar)}</td></tr>`
  ).join("");

  return `<table data-section="hourly-exact" data-hour-layout="single" width="100%" role="presentation" cellspacing="0" cellpadding="2"><tr><td><strong>24 小时精确值（Token）</strong></td></tr>${rows}</table>`;
}
```

删除只为单双列启发式存在的 `rawValue` 字段和 `displayValue.length > 10` 判断；`miniPercent`、完整数字和预算降级语义保持不变。

- [ ] **Step 4: 运行结构、预算和规则聚焦测试**

Run:

```powershell
npx vitest run test/usage-dashboard-html.test.ts test/rules.test.ts test/app.test.ts
```

Expected: 三个测试文件全部通过；典型输入仍为 rich 且不超过 18,000 字符，极端输入自动选择 compatibility，两个变体都保留 24 个单列精确值。

- [ ] **Step 5: 提交精确值移动端结构**

```powershell
git add -- src/usage-dashboard-html.ts test/usage-dashboard-html.test.ts test/app.test.ts
git diff --cached --check
git commit -m "修复：将每小时精确值改为移动端单列"
```

---

### Task 3: 更新使用说明并收敛回归

**Files:**
- Modify: `README.md:7-17`

**Interfaces:**
- Consumes: Task 1 和 Task 2 产生的稳定 `data-quota-*`、`data-hour-row`、`data-mini-bar-row` 标记。
- Produces: README 明确用户可见的移动端结构；聚焦回归确认文档提交没有带入代码改动。

- [ ] **Step 1: 更新 README 的移动端行为说明**

把第 2 项和第 5 项改为：

```markdown
2. 三个移动端额度块（名称、重置时间和百分比在上，进度条独占下一整行）。
5. 固定单列的 24 小时精确值；富版为每个小时保留一条全宽迷你条。
```

在预算说明后追加：

```markdown
仪表盘使用移动优先的纵向表格，不依赖媒体查询或固定字号；手机竖屏和字体放大时，动态 Token 数字只会在自己的单元格内换行，不会与相邻小时重叠。
```

- [ ] **Step 2: 运行应用、规则和渲染器回归**

Run:

```powershell
npx vitest run test/usage-dashboard-html.test.ts test/rules.test.ts test/app.test.ts
```

Expected: 三个文件全部通过；应用仍只创建并投递一个事件，不创建新的图表快照。

- [ ] **Step 3: 提交使用说明**

```powershell
git add -- README.md
git diff --cached --check
git commit -m "文档：说明移动端仪表盘布局"
```

---

### Task 4: 完整验证、独立审查与中文 PR

**Files:**
- Review: `src/usage-dashboard-html.ts`
- Review: `test/usage-dashboard-html.test.ts`
- Review: `test/app.test.ts`
- Review: `README.md`
- Review: `docs/superpowers/specs/2026-08-09-pushplus-mobile-layout-fix-design.md`

**Interfaces:**
- Consumes: 前三项任务的提交。
- Produces: 经验证和独立审查的远程分支及中文 PR；不部署生产。

- [ ] **Step 1: 执行完整本地验收**

Run:

```powershell
npm run check
npx wrangler deploy --dry-run
git diff --check master...HEAD
git status --short
```

Expected:

- TypeScript 类型检查通过；
- 所有 Vitest 与授权流程测试通过；
- Wrangler dry-run 成功且绑定、定时规则和 D1 配置未变化；
- `git diff --check` 无输出；
- 工作树干净。

- [ ] **Step 2: 进行整分支独立审查**

审查必须对照设计规格逐项确认：

- 三个额度条的进度轨道各自独占整行；
- rich 和 compatibility 都固定单列 24 项且顺序正确；
- rich 每小时迷你条独占全宽行，compatibility 不生成迷你条；
- 动态 Token 数字不带 `nowrap`，但小时和百分比仍可保持不换行；
- 0%、100%、全零、跨日、超长整数、截断、转义和预算降级没有回归；
- 没有媒体查询、新依赖、外链资源、生产配置或业务主链路改动；
- 测试验证真实表格结构，没有仅凭 data 属性自证。

任何 Critical 或 Important 发现都必须先补失败测试，再做最小修复，并只进行一次修复范围复审。

- [ ] **Step 3: 推送分支并创建可审阅中文 PR**

```powershell
git push -u origin codex/pushplus-mobile-layout-fix
gh pr create --base master --head codex/pushplus-mobile-layout-fix --title "修复 PushPlus 仪表盘移动端拥挤" --body-file .pr-body-mobile-layout.md
```

PR 正文必须说明：

- 根因是自动表格布局中的横向列竞争；
- 额度条改为元信息在上、全宽进度条在下；
- 24 小时精确值采用用户选择的方案 B：固定单列并保留每小时全宽迷你条；
- 动态数值允许在自身单元格内换行；
- 不改采集、调度、幂等、发送、回调或历史 SVG；
- 列出本次实际测试数量、Wrangler dry-run 和独立审查结论；
- 合并前未部署、未发送真实广播，合并后仅进行一次生产烟测。
