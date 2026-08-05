# OpenCode `/usage` 明细与图表广播实施计划

> **供智能代理执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在现有 OpenCode Go 整点与手动广播中，增加最近 24 个北京时间小时桶的 Token 汇总、模型排行和签名 SVG 图表，同时保证 `/usage` 的任何故障都不阻断三项 `/go` 额度广播。

**架构：** 授权工具在一次可见 GitHub 登录中捕获 `/go` 与 `usage.list` 请求，生成向后兼容的版本 2 会话包；Worker 串行回放 `usage.list`、去重并聚合最近 24 小时。消息正文与只含 24 个聚合桶的图表快照在同一 D1 事务中写入，微信点击 PushPlus 详情后通过 HMAC 签名地址读取 Worker 动态生成的 SVG；明细、签名或快照失败时降级为仍可发送的文字或额度消息。

**技术栈：** TypeScript 7、Cloudflare Workers、D1、Web Crypto、Wrangler 4.118.0、Playwright Core 1.62.1、Vitest Workers Pool。

## 全局约束

- 自动广播仍只允许北京时间每天 09:00 至 23:00 整点，Cloudflare Cron 仍为 UTC `0 1-15 * * *`；手动广播仍可随时触发。
- 会话包版本 1 必须继续支持 `/go`，并明确把 24 小时明细降级为“尚未授权”；版本 2 不保存 GitHub 密码。
- OpenCode 请求只允许 `https://opencode.ai`、标准 HTTPS 端口、同一工作区、已捕获的只读方法与固定参数；只保存 `Accept` 和实际需要的 `Content-Type`，Cookie 单独保存。
- `/go` 固定为无查询参数的 `GET /workspace/<工作区>/go`；`usage.list` 请求体最大 16 KiB，运行时只能替换经过验证的非负安全整数页号。
- `/go` 与每个 `usage.list` 请求各有 10 秒超时、512 KiB 响应上限、禁止自动重定向；明细整段最多 25 秒、40 页、2000 条，分页必须串行。
- `usage.list` 每页最多 50 条并按 `timeCreated` 倒序；稳定 `id` 去重，边界重复可接受，同一 `id` 内容冲突、删除、重排或非倒序按结构故障降级。
- 最近 24 小时指当前北京时间小时及此前 23 个连续小时桶；当前小时是部分小时，采集开始后的新记录留到下一次广播。
- Token 总量严格等于原始输入、原始输出、推理、缓存四类之和；缓存为读取、5 分钟写入、1 小时写入之和；空推理和缓存字段按零；费用直接汇总上游微美分并除以 `100000000` 显示美元。
- 消息只列 Token 总量前 5 个模型，其余合并为“其他”；同量按模型名稳定排序，所有上游文本进入 HTML 前必须转义。
- 消息不展示最近若干条逐请求记录；逐条记录只在本次 Worker 内存中用于聚合，不写入 D1 或日志。
- SVG 只包含 24 个聚合桶，不包含模型、逐条记录、成员、提示词、Cookie 或请求头；签名 Secret 与现有 Secret 分离，图表快照保留 30 天，每次最多清理 200 条。
- `/usage`、图表签名、图表快照或图表读取失败不得改变现有 `/go` 成功消息；`/go` 失败仍不得发送可能过期的额度或明细。
- 外链 SVG 在真实微信详情页可见是生产发布门槛；本次不预设 PNG 或第三方图表服务后备方案。
- 不增加运行时依赖，不改 `package-lock.json`；只增加覆盖新协议、分页、聚合、签名、原子写入和降级主路径的精简测试。
- 所有 GitHub 可见标题、正文、提交、PR、工作流名称和代码注释使用中文；平台字段名、命令、URL 与代码标识符除外。

---

## 文件结构

### 新建文件

- `src/usage-domain.ts`：统一定义逐条用量、分页结果、24 小时聚合、消息视图和图表快照数据，不包含网络或渲染逻辑。
- `src/opencode-http.ts`：复用 Cookie 的受限 OpenCode 请求回放，统一超时、响应大小、状态分类和重定向策略。
- `src/opencode-usage.ts`：严格解析 `usage.list` 的 JSON/JSON 序列化响应，规范化字段并验证单页倒序。
- `src/opencode-usage-source.ts`：版本 1 降级、版本 2 串行分页、稳定编号去重、24 小时停止边界和截断结果。
- `scripts/opencode-usage-capture.ts`：浏览器捕获请求的最小化、页号模板推导和第 0/1 页配对纯函数。
- `src/usage-aggregate.ts`：北京时间 24 小时桶、Token/费用总计、模型前五与“其他”聚合。
- `src/usage-chart.ts`：图表数据序列化、HMAC 地址、严格验签、SVG 渲染和图表 HTTP 处理器。
- `migrations/0005_usage_chart_snapshots.sql`：与发件箱事件关联的聚合图表快照表及清理索引。
- `test/opencode-session-bundle.test.ts`：版本 1/2 会话包和分页模板协议测试。
- `test/opencode-usage.test.ts`：单页解析、字段归零、费用和倒序测试。
- `test/opencode-usage-source.test.ts`：分页、去重、边界、单页升级和截断测试。
- `test/usage-aggregate.test.ts`：24 小时边界、四类 Token 和模型排行测试。
- `test/usage-chart.test.ts`：签名、篡改、SVG、查询限制和 404 测试。

### 修改文件

- `src/opencode-session.ts`：把会话包扩展为版本 1/2 判别联合，并提供安全的请求模板校验与渲染。
- `src/source.ts`：保持 `QuotaSource` 只处理 `/go`，改用公共回放器，并让版本 2 读取 `goRequest`。
- `scripts/auth-setup.ts`、`scripts/auth-setup.test-node.ts`：捕获两类请求、必要时自动点下一页、上传版本 2 会话包，并支持仅创建 Worker 版本的上传模式。
- `src/rules.ts`、`test/rules.test.ts`：在三项额度之后渲染文字明细、模型排行、可选图表和降级说明。
- `src/repository.ts`、`test/repository.test.ts`：把图表快照加入受租约保护的原子提交，并提供读取与限量清理。
- `src/config.ts`、`test/config-source.test.ts`、`wrangler.jsonc`、`.dev.vars.example`、`vitest.config.ts`、`worker-configuration.d.ts`：增加公开根地址、图表签名 Secret、预览 URL 与类型绑定。
- `src/index.ts`：在 PushPlus 回调通用门禁之前增加严格的签名 SVG GET 路由。
- `src/app.ts`、`test/app.test.ts`：独立采集明细、二次检查整点过期、生成同编号文字/图表事件、事务失败降级及 30 天清理。
- `test/pushplus.test.ts`：回归确认含 `<img>` 的 HTML 原样发送；`src/pushplus.ts` 业务逻辑保持不变。
- `package.json`：把 Node 授权工具测试纳入 `npm run check`。
- `README.md`：记录授权升级、消息口径、Secret、预览微信验收、降级和保留策略。

---

### 任务 1：建立用量协议、会话包版本 2 与受限回放器

**文件：**

- 新建：`src/usage-domain.ts`
- 新建：`src/opencode-http.ts`
- 新建：`src/opencode-usage.ts`
- 修改：`src/opencode-session.ts`
- 修改：`src/source.ts`
- 新建测试：`test/opencode-session-bundle.test.ts`
- 新建测试：`test/opencode-usage.test.ts`
- 修改测试：`test/opencode-session.test.ts`

**接口：**

- 产出：`OpenCodeSessionBundle = OpenCodeSessionBundleV1 | OpenCodeSessionBundleV2`、`parseSessionBundle(raw): OpenCodeSessionBundle`、`renderUsagePageRequest(firstPage, template, page): OpenCodeRequestDescriptor`。
- 产出：`parseUsageListPage(text, contentType): UsageRecord[]`，只返回 0 至 50 条已规范化且倒序的记录。
- 产出：`replayOpenCodeRequest(request, cookie, fetchImpl, outerSignal?): Promise<OpenCodeReplayResult>`。
- 产出：`parseOpenCodeGoResponse(text): unknown`；旧名 `parseOpenCodeUsageResponse` 同步替换，避免与逐条 usage 记录混淆。
- 保持：`OpenCodeConsoleQuotaSource.fetch(now): Promise<QuotaSnapshot>` 仍只采集 `/go`。

- [ ] **步骤 1：先写会话包和单页解析失败测试**

  在两个新测试文件中固定版本 2 结构、唯一页号替换、版本 1 兼容、空可选 Token 归零、费用原值和倒序拒绝：

  ```ts
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "use_1",
    timeCreated: "2026-08-05T02:30:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    cost: 25000000,
    ...overrides
  });

  function makeV2Bundle(): OpenCodeSessionBundleV2 {
    return {
      version: 2,
      generation: "generation-v2",
      createdAt: "2026-08-05T03:00:00.000Z",
      workspaceId: "wrk_abc",
      auth: { cookie: "auth=test-cookie" },
      goRequest: {
        url: "https://opencode.ai/workspace/wrk_abc/go",
        method: "GET",
        headers: { accept: "text/html" }
      },
      usageList: {
        firstPage: {
          url: "https://opencode.ai/_server?id=usage.list",
          method: "POST",
          headers: {
            accept: "text/javascript",
            "content-type": "application/json"
          },
          body: '["wrk_abc",0]'
        },
        pagination: {
          mode: "paginated",
          template: {
            location: "body",
            prefix: '["wrk_abc",',
            suffix: "]"
          }
        }
      }
    };
  }

  it("解析版本 2 并只替换请求体中的页号", () => {
    const bundle = parseSessionBundle(JSON.stringify(makeV2Bundle()));
    expect(bundle.version).toBe(2);
    if (bundle.version !== 2 || bundle.usageList.pagination.mode !== "paginated") {
      throw new Error("测试会话包不是分页版本 2");
    }
    expect(renderUsagePageRequest(
      bundle.usageList.firstPage,
      bundle.usageList.pagination.template,
      7
    ).body).toBe('["wrk_abc",7]');
  });

  it("把空推理和缓存字段规范化为零", () => {
    expect(parseUsageListPage(
      JSON.stringify([row()]),
      "application/json; charset=utf-8"
    )).toEqual([expect.objectContaining({
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      costMicroCents: 25000000
    })]);
  });

  it("拒绝非倒序的单页", () => {
    expect(() => parseUsageListPage(JSON.stringify([
      row({ id: "use_old", timeCreated: "2026-08-05T01:00:00.000Z" }),
      row({ id: "use_new", timeCreated: "2026-08-05T02:00:00.000Z" })
    ]), "text/javascript")).toThrow("倒序");
  });
  ```

- [ ] **步骤 2：运行定向测试并确认缺少新接口**

  ```powershell
  npx vitest run test/opencode-session-bundle.test.ts test/opencode-usage.test.ts test/opencode-session.test.ts
  ```

  预期：新测试因 `usage-domain.ts`、`parseUsageListPage`、版本 2 类型和 `renderUsagePageRequest` 尚不存在而失败；原 `/go` 测试仍能编译到原接口。

- [ ] **步骤 3：定义跨任务共用的精确领域类型**

  在 `src/usage-domain.ts` 写入以下类型，后续任务不得另起同义字段名：

  ```ts
  export interface UsageRecord {
    id: string;
    occurredAt: number;
    provider: string;
    model: string;
    plan?: "sub" | "byok" | "lite";
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWrite5mTokens: number;
    cacheWrite1hTokens: number;
    costMicroCents: number;
  }

  export type UsageCollectionResult =
    | { status: "complete"; records: UsageRecord[]; pagesRead: number }
    | {
        status: "truncated";
        records: UsageRecord[];
        pagesRead: number;
        reason: "page-limit" | "deadline";
      }
    | {
        status: "unavailable";
        reason: "not-authorized" | "single-page-full";
      };

  export interface UsageDetailsSource {
    fetch(observedAt: number): Promise<UsageCollectionResult>;
  }
  ```

- [ ] **步骤 4：实现版本 1/2 严格会话协议**

  在 `src/opencode-session.ts` 保留版本 1 字段不变，并增加这些公开结构：

  ```ts
  export interface OpenCodeRequestDescriptor {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }

  export type UsagePageNumberTemplate =
    | { location: "url"; prefix: string; suffix: string }
    | { location: "body"; prefix: string; suffix: string };

  export type UsagePaginationAuthorization =
    | { mode: "single-page" }
    | { mode: "paginated"; template: UsagePageNumberTemplate };

  export interface OpenCodeSessionBundleV2 {
    version: 2;
    generation: string;
    createdAt: string;
    workspaceId: string;
    auth: { cookie: string };
    goRequest: OpenCodeRequestDescriptor;
    usageList: {
      firstPage: OpenCodeRequestDescriptor;
      pagination: UsagePaginationAuthorization;
    };
  }

  export type OpenCodeSessionBundle =
    | OpenCodeSessionBundleV1
    | OpenCodeSessionBundleV2;
  ```

  `parseSessionBundle` 必须按 `version` 分支执行精确字段白名单；`validateOpenCodeGoRequest` 继续只接受无查询的 `/go` GET；`validateUsageListRequestDescriptor(request, workspaceId, expectedPage)` 只接受 GET 或 POST、限制 16 KiB 请求体和允许头，GET 不得有 body，POST 必须有 body 和 `Content-Type`。它必须在请求体及逐个 URL 查询值中尝试严格 `JSON.parse`，并且恰好找到一个服务函数参数数组 `[workspaceId, expectedPage]`；若两处都找到、没有找到、参数多于两个或工作区不一致均拒绝。每页 50 条由上游 `usage.list` 响应契约校验，不在请求中虚构第三个参数。分页模板必须满足 `renderUsagePageRequest(firstPage, template, 0)` 与第零页逐字节一致，页号不能位于协议、主机、路径或请求头：

  ```ts
  export function renderUsagePageRequest(
    firstPage: OpenCodeRequestDescriptor,
    template: UsagePageNumberTemplate,
    page: number
  ): OpenCodeRequestDescriptor {
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new SourceError("schema", "usage.list 页号无效");
    }
    const rendered = template.prefix + String(page) + template.suffix;
    return template.location === "url"
      ? { ...firstPage, url: rendered }
      : { ...firstPage, body: rendered };
  }
  ```

- [ ] **步骤 5：实现单页响应的严格规范化**

  `src/opencode-usage.ts` 只允许 `application/json`、`text/javascript` 或 `text/plain` 媒体类型，正文必须能 `JSON.parse`。若序列化外壳存在，递归搜索必须得到唯一一个“数组中每项均为完整用量记录”的候选；零记录只接受根值为空数组。字段按以下代码规范化，并在返回前断言最多 50 条及 `occurredAt` 非递增：

  ```ts
  function requireRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new SourceError("schema", "usage.list 字段无效：" + field);
    }
    return value as Record<string, unknown>;
  }

  function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new SourceError("schema", "usage.list 字段无效：" + field);
    }
    return value;
  }

  function requireSafeInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new SourceError("schema", "usage.list 字段无效：" + field);
    }
    return Number(value);
  }

  function optionalSafeInteger(value: unknown, field: string): number {
    if (value === null || value === undefined) return 0;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new SourceError("schema", "usage.list 字段无效：" + field);
    }
    return Number(value);
  }

  function requireOptionalPlan(value: unknown): UsageRecord["plan"] {
    if (value === null || value === undefined) return undefined;
    const enrichment = requireRecord(value, "enrichment");
    if (enrichment.plan === undefined || enrichment.plan === null) return undefined;
    if (
      enrichment.plan !== "sub" &&
      enrichment.plan !== "byok" &&
      enrichment.plan !== "lite"
    ) {
      throw new SourceError("schema", "usage.list 套餐来源无效");
    }
    return enrichment.plan;
  }

  function parseUsageRecord(value: unknown): UsageRecord {
    const item = requireRecord(value, "记录");
    const occurredAt = Date.parse(requireString(item.timeCreated, "timeCreated"));
    if (!Number.isFinite(occurredAt)) {
      throw new SourceError("schema", "usage.list 时间无效");
    }
    const plan = requireOptionalPlan(item.enrichment);
    return {
      id: requireString(item.id, "id"),
      occurredAt,
      provider: requireString(item.provider, "provider"),
      model: requireString(item.model, "model"),
      ...(plan === undefined ? {} : { plan }),
      inputTokens: requireSafeInteger(item.inputTokens, "inputTokens"),
      outputTokens: requireSafeInteger(item.outputTokens, "outputTokens"),
      reasoningTokens: optionalSafeInteger(item.reasoningTokens, "reasoningTokens"),
      cacheReadTokens: optionalSafeInteger(item.cacheReadTokens, "cacheReadTokens"),
      cacheWrite5mTokens: optionalSafeInteger(item.cacheWrite5mTokens, "cacheWrite5mTokens"),
      cacheWrite1hTokens: optionalSafeInteger(item.cacheWrite1hTokens, "cacheWrite1hTokens"),
      costMicroCents: requireSafeInteger(item.cost, "cost")
    };
  }

  function looksLikeUsageRecord(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const item = value as Record<string, unknown>;
    return [
      "id", "timeCreated", "provider", "model",
      "inputTokens", "outputTokens", "cost"
    ].every((key) => Object.hasOwn(item, key));
  }

  function collectUsageArrays(value: unknown, output: unknown[][]): void {
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(looksLikeUsageRecord)) {
        output.push(value);
        return;
      }
      for (const child of value) collectUsageArrays(child, output);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) collectUsageArrays(child, output);
    }
  }

  export function parseUsageListPage(
    text: string,
    contentType: string
  ): UsageRecord[] {
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (!["application/json", "text/javascript", "text/plain"].includes(mediaType)) {
      throw new SourceError("schema", "usage.list 响应类型无效");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SourceError("schema", "usage.list 响应不是有效 JSON");
    }
    if (Array.isArray(parsed) && parsed.length === 0) return [];
    const candidates: unknown[][] = [];
    collectUsageArrays(parsed, candidates);
    if (candidates.length !== 1) {
      throw new SourceError("schema", "usage.list 响应记录数组不唯一");
    }
    const records = candidates[0]!.map(parseUsageRecord);
    if (records.length > 50) {
      throw new SourceError("schema", "usage.list 单页超过 50 条");
    }
    for (let index = 1; index < records.length; index += 1) {
      if (records[index]!.occurredAt > records[index - 1]!.occurredAt) {
        throw new SourceError("schema", "usage.list 记录不是倒序");
      }
    }
    return records;
  }
  ```

- [ ] **步骤 6：抽取受限 HTTP 回放并保持 `/go` 行为**

  将 `source.ts` 中的受限读取、登录重定向和状态分类移入 `src/opencode-http.ts`，公开：

  ```ts
  export interface OpenCodeReplayResult {
    text: string;
    contentType: string;
  }

  export async function replayOpenCodeRequest(
    request: OpenCodeRequestDescriptor,
    cookie: string,
    fetchImpl: typeof fetch = fetch,
    outerSignal?: AbortSignal
  ): Promise<OpenCodeReplayResult>;
  ```

  实现必须使用 `redirect: "manual"`，用内部 10 秒计时器与可选外层信号共同中止，流式读取最大 512 KiB；401、403 和 `/auth` 重定向抛 `SourceError("auth")`，408、429、5xx、网络和超时抛 `SourceError("transient")`，其他非 2xx、媒体类型或结构问题抛 `SourceError("schema")`。`OpenCodeConsoleQuotaSource` 对传入对象也先 `JSON.stringify` 后调用 `parseSessionBundle`，版本 1 读取 `request`，版本 2 读取 `goRequest`。

- [ ] **步骤 7：运行协议回归并提交**

  ```powershell
  npx vitest run test/opencode-session-bundle.test.ts test/opencode-usage.test.ts test/opencode-session.test.ts test/config-source.test.ts
  npm run typecheck
  git diff --check
  git add src/usage-domain.ts src/opencode-http.ts src/opencode-usage.ts src/opencode-session.ts src/source.ts test/opencode-session-bundle.test.ts test/opencode-usage.test.ts test/opencode-session.test.ts
  git commit -m "支持 OpenCode 用量明细协议"
  ```

  预期：定向测试和类型检查通过，原 `/go` JSON/HTML、认证、超时和响应上限用例不回归。

---

### 任务 2：实现最近 24 小时的串行分页采集

**文件：**

- 新建：`src/opencode-usage-source.ts`
- 新建测试：`test/opencode-usage-source.test.ts`
- 修改测试：`test/config-source.test.ts`

**接口：**

- 消费：任务 1 的 `OpenCodeSessionBundle`、`renderUsagePageRequest`、`parseUsageListPage`、`replayOpenCodeRequest` 和 `UsageCollectionResult`。
- 产出：`OpenCodeUsageListSource implements UsageDetailsSource`。
- 产出：`createUsageDetailsSource(config, fetchImpl?, clock?): UsageDetailsSource`；版本 1、fixture 或禁用来源返回 `not-authorized`，不抛出 `/go` 故障。

- [ ] **步骤 1：写分页、去重、边界和截断失败测试**

  使用固定页工厂验证第 0 页恰好 50 条会请求第 1 页、跨页重复编号只计一次、早于窗口起点后停止、单页授权后来满 50 条要求重新授权、40 页仍未越界时标记截断：

  ```ts
  function pageOf(count: number, start: number): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
      id: "use_" + String(start + index),
      timeCreated: new Date(Date.parse("2026-08-05T03:29:00.000Z") -
        (start + index) * 1000).toISOString(),
      provider: "anthropic",
      model: "claude-sonnet",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cost: 1
    }));
  }

  function makeRawV2Bundle(
    pagination: UsagePaginationAuthorization = {
      mode: "paginated",
      template: {
        location: "body",
        prefix: '["wrk_abc",',
        suffix: "]"
      }
    }
  ): string {
    return JSON.stringify({
      version: 2,
      generation: "generation-v2",
      createdAt: "2026-08-05T03:00:00.000Z",
      workspaceId: "wrk_abc",
      auth: { cookie: "auth=test-cookie" },
      goRequest: {
        url: "https://opencode.ai/workspace/wrk_abc/go",
        method: "GET",
        headers: { accept: "text/html" }
      },
      usageList: {
        firstPage: {
          url: "https://opencode.ai/_server?id=usage.list",
          method: "POST",
          headers: {
            accept: "text/javascript",
            "content-type": "application/json"
          },
          body: '["wrk_abc",0]'
        },
        pagination
      }
    });
  }

  function makePaginatedSource(input: {
    pages: unknown[][];
    onPage?: (page: number) => void;
  }): OpenCodeUsageListSource {
    return new OpenCodeUsageListSource(
      makeRawV2Bundle(),
      async (_url, init) => {
        const page = Number(JSON.parse(String(init?.body))[1]);
        input.onPage?.(page);
        return new Response(JSON.stringify(input.pages[page] ?? []), {
          headers: { "content-type": "application/json" }
        });
      }
    );
  }

  function makeSinglePageSource(page: unknown[]): OpenCodeUsageListSource {
    return new OpenCodeUsageListSource(
      makeRawV2Bundle({ mode: "single-page" }),
      async () => new Response(JSON.stringify(page), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  function makeFortyFullPagesSource(): OpenCodeUsageListSource {
    return makePaginatedSource({
      pages: Array.from({ length: 40 }, (_, page) => pageOf(50, page * 50))
    });
  }

  it("串行读取并去除分页边界重复", async () => {
    const calls: number[] = [];
    const source = makePaginatedSource({
      pages: [pageOf(50, 0), pageOf(20, 49)],
      onPage: (page) => calls.push(page)
    });
    const result = await source.fetch(Date.parse("2026-08-05T03:30:00.000Z"));
    expect(calls).toEqual([0, 1]);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(new Set(result.records.map((item) => item.id)).size)
        .toBe(result.records.length);
    }
  });

  it("单页授权出现满页时拒绝冒充完整结果", async () => {
    const result = await makeSinglePageSource(pageOf(50, 0)).fetch(
      Date.parse("2026-08-05T03:30:00.000Z")
    );
    expect(result).toEqual({
      status: "unavailable",
      reason: "single-page-full"
    });
  });

  it("达到四十页时返回至少口径", async () => {
    const result = await makeFortyFullPagesSource().fetch(
      Date.parse("2026-08-05T03:30:00.000Z")
    );
    expect(result).toEqual(expect.objectContaining({
      status: "truncated",
      pagesRead: 40,
      reason: "page-limit"
    }));
  });
  ```

- [ ] **步骤 2：运行定向测试并确认来源尚不存在**

  ```powershell
  npx vitest run test/opencode-usage-source.test.ts test/config-source.test.ts
  ```

  预期：因 `OpenCodeUsageListSource` 和 `createUsageDetailsSource` 尚未定义而失败。

- [ ] **步骤 3：实现显式状态的串行分页器**

  `src/opencode-usage-source.ts` 使用以下常量和构造签名：

  ```ts
  const PAGE_SIZE = 50;
  const MAX_PAGES = 40;
  const COLLECTION_DEADLINE_MS = 25_000;
  const HOUR_MS = 60 * 60 * 1000;

  export class OpenCodeUsageListSource implements UsageDetailsSource {
    constructor(
      private readonly rawBundle: string | OpenCodeSessionBundle,
      private readonly fetchImpl: typeof fetch = fetch,
      private readonly clock: () => number = Date.now
    ) {}

    async fetch(observedAt: number): Promise<UsageCollectionResult>;
  }
  ```

  `fetch` 必须先校验 `observedAt`，把窗口起点算为当前北京时间小时起点减 23 小时；版本 1立即返回 `not-authorized`。版本 2 从页 0 开始；单页模式的第零页若恰有 50 条，必须在使用这些记录前直接返回 `single-page-full`。分页模式每页完成后依次执行：页内/跨页倒序校验、稳定 `id` 去重、同编号内容一致性校验、仅保留 `windowStartAt <= occurredAt <= observedAt`、遇到 `< windowStartAt` 或短页停止。分页模式用 `renderUsagePageRequest` 生成下一页。核心循环按以下顺序实现：

  ```ts
  function requirePaginationTemplate(
    pagination: UsagePaginationAuthorization
  ): UsagePageNumberTemplate {
    if (pagination.mode !== "paginated") {
      throw new SourceError("schema", "usage.list 缺少分页模板");
    }
    return pagination.template;
  }

  const bundle = parseSessionBundle(
    typeof this.rawBundle === "string"
      ? this.rawBundle
      : JSON.stringify(this.rawBundle)
  );
  if (bundle.version === 1) {
    return { status: "unavailable", reason: "not-authorized" };
  }
  if (!Number.isFinite(observedAt)) {
    throw new SourceError("schema", "usage.list 观察时间无效");
  }
  const shanghaiHourStart =
    Math.floor((observedAt + 8 * HOUR_MS) / HOUR_MS) * HOUR_MS - 8 * HOUR_MS;
  const windowStartAt = shanghaiHourStart - 23 * HOUR_MS;
  const deadline = this.clock() + COLLECTION_DEADLINE_MS;
  const records: UsageRecord[] = [];
  const seen = new Map<string, string>();
  let previousUnique: UsageRecord | undefined;
  let pagesRead = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (this.clock() >= deadline) {
      return { status: "truncated", records, pagesRead, reason: "deadline" };
    }
    const request = page === 0
      ? bundle.usageList.firstPage
      : renderUsagePageRequest(
          bundle.usageList.firstPage,
          requirePaginationTemplate(bundle.usageList.pagination),
          page
        );
    validateUsageListRequestDescriptor(request, bundle.workspaceId, page);
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(),
      Math.max(0, deadline - this.clock())
    );
    let replay: OpenCodeReplayResult;
    try {
      replay = await replayOpenCodeRequest(
        request,
        bundle.auth.cookie,
        this.fetchImpl,
        deadlineController.signal
      );
    } catch (error) {
      if (deadlineController.signal.aborted && this.clock() >= deadline) {
        return { status: "truncated", records, pagesRead, reason: "deadline" };
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }

    const pageRecords = parseUsageListPage(replay.text, replay.contentType);
    pagesRead += 1;
    if (
      page === 0 &&
      bundle.usageList.pagination.mode === "single-page" &&
      pageRecords.length === PAGE_SIZE
    ) {
      return { status: "unavailable", reason: "single-page-full" };
    }

    let reachedBoundary = false;
    for (const record of pageRecords) {
      const fingerprint = JSON.stringify(record);
      const priorFingerprint = seen.get(record.id);
      if (priorFingerprint !== undefined) {
        if (priorFingerprint !== fingerprint) {
          throw new SourceError("schema", "usage.list 同编号记录发生变化");
        }
        continue;
      }
      if (previousUnique && record.occurredAt > previousUnique.occurredAt) {
        throw new SourceError("schema", "usage.list 跨页记录不是倒序");
      }
      seen.set(record.id, fingerprint);
      previousUnique = record;
      if (record.occurredAt > observedAt) continue;
      if (record.occurredAt < windowStartAt) {
        reachedBoundary = true;
        break;
      }
      records.push(record);
    }
    if (reachedBoundary || pageRecords.length < PAGE_SIZE) {
      return { status: "complete", records, pagesRead };
    }
  }
  ```

  达到页数限制且仍未看到边界时返回：

  ```ts
  return {
    status: "truncated",
    records,
    pagesRead,
    reason: pagesRead === MAX_PAGES ? "page-limit" : "deadline"
  };
  ```

  25 秒期限在每次发请求前和响应后检查；单请求仍由公共回放器限制为 10 秒。网络、认证和结构异常继续抛 `SourceError`，留给应用层局部降级，不在分页器整体重试。

- [ ] **步骤 4：接入来源工厂并覆盖版本 1 降级**

  ```ts
  class UnavailableUsageDetailsSource implements UsageDetailsSource {
    async fetch(): Promise<UsageCollectionResult> {
      return { status: "unavailable", reason: "not-authorized" };
    }
  }

  export function createUsageDetailsSource(
    config: AppConfig,
    fetchImpl: typeof fetch = fetch,
    clock: () => number = Date.now
  ): UsageDetailsSource {
    if (
      config.sourceName !== "opencode-console" ||
      !config.consoleEnabled ||
      config.sessionBundle === undefined
    ) {
      return new UnavailableUsageDetailsSource();
    }
    return new OpenCodeUsageListSource(config.sessionBundle, fetchImpl, clock);
  }
  ```

  在 `test/config-source.test.ts` 增加版本 2 generation 与两种 source 都可创建、版本 1 `/go` 正常而明细 `not-authorized`、损坏分页模板在网络前失败的断言。

- [ ] **步骤 5：运行分页测试并提交**

  ```powershell
  npx vitest run test/opencode-usage-source.test.ts test/config-source.test.ts test/opencode-session.test.ts
  npm run typecheck
  git diff --check
  git add src/opencode-usage-source.ts test/opencode-usage-source.test.ts test/config-source.test.ts
  git commit -m "实现用量明细分页采集"
  ```

  预期：页号严格为 `[0, 1, 2]` 的顺序调用，单页满页、超时和 40 页分别给出明确状态，`/go` 测试继续通过。

---

### 任务 3：升级一次登录授权工具并支持版本级 Secret

**文件：**

- 新建：`scripts/opencode-usage-capture.ts`
- 修改：`scripts/auth-setup.ts`
- 修改：`scripts/auth-setup.test-node.ts`
- 修改：`package.json`

**接口：**

- 消费：任务 1 的请求描述、会话包解析和单页解析；任务 2 的 `OpenCodeUsageListSource` 用于上传前真实回放验证。
- 产出：`minimizeCapturedRequest(raw): OpenCodeRequestDescriptor`、`deriveUsagePageNumberTemplate(page0, page1): UsagePageNumberTemplate`。
- 产出：`buildSessionBundle(workspaceId, authCookie, goRequest, usageList): OpenCodeSessionBundleV2`，返回值再次经过 `parseSessionBundle` 严格校验。
- 产出：`parseAuthSetupArgs(argv): { uploadMode: "deployed" | "version-only" }`。
- 产出：`uploadSessionBundle(sessionBundle, signal, options?): Promise<void>`，默认沿用立即部署模式，`version-only` 改用 `wrangler versions secret put`。

- [ ] **步骤 1：写捕获纯函数和上传参数失败测试**

  在 Node 测试中断言浏览器头只保留白名单、页号只能有一个 `0` 到 `1` 的差异、固定 URL/头变化会拒绝，以及两种 Wrangler 参数准确：

  ```ts
  test("只保留捕获请求的必要头", () => {
    assert.deepEqual(minimizeCapturedRequest({
      url: "https://opencode.ai/_server?id=usage.list",
      method: "POST",
      headers: {
        accept: "text/javascript",
        "content-type": "application/json",
        cookie: "不得进入结果",
        origin: "https://opencode.ai",
        "x-test": "不得进入结果"
      },
      body: '["wrk_abc",0]'
    }), {
      url: "https://opencode.ai/_server?id=usage.list",
      method: "POST",
      headers: {
        accept: "text/javascript",
        "content-type": "application/json"
      },
      body: '["wrk_abc",0]'
    });
  });

  test("版本级模式使用 versions secret put", () => {
    assert.deepEqual(buildWranglerSecretArgs("wrangler.js", "version-only"), [
      "wrangler.js", "versions", "secret", "put", "OPENCODE_SESSION_BUNDLE"
    ]);
  });
  ```

- [ ] **步骤 2：运行 Node 测试并确认新接口缺失**

  ```powershell
  npx tsx --test scripts/auth-setup.test-node.ts
  ```

  预期：因请求最小化、模板推导和上传模式接口不存在而失败；现有取消、超时和清理测试仍保留。

- [ ] **步骤 3：实现安全捕获与唯一页号模板**

  `scripts/opencode-usage-capture.ts` 定义 `RawCapturedRequest`，使用 `request.headers()` 而不是包含 Cookie 的 `allHeaders()`，只复制 `accept` 和存在请求体时的 `content-type`。页号模板必须满足方法、头、协议、主机、路径和非页号字节一致，并且 URL 与 body 恰有一个发生变化：

  ```ts
  export function deriveUniqueZeroToOneTemplate(
    zero: string,
    one: string
  ): { prefix: string; suffix: string } {
    let start = 0;
    while (start < zero.length && start < one.length && zero[start] === one[start]) {
      start += 1;
    }
    let zeroEnd = zero.length;
    let oneEnd = one.length;
    while (
      zeroEnd > start &&
      oneEnd > start &&
      zero[zeroEnd - 1] === one[oneEnd - 1]
    ) {
      zeroEnd -= 1;
      oneEnd -= 1;
    }
    if (zero.slice(start, zeroEnd) !== "0" || one.slice(start, oneEnd) !== "1") {
      throw new Error("无法唯一定位 usage.list 页号");
    }
    return { prefix: zero.slice(0, start), suffix: zero.slice(zeroEnd) };
  }
  ```

- [ ] **步骤 4：捕获 `/go`、第零页及必要的第一页**

  在导航前建立 `page.waitForResponse`，响应必须来自同源、状态成功、正文不超过 512 KiB，并分别通过 `/go` 或 `parseUsageListPage` 验证。访问 `/usage` 后若第零页少于 50 条，保存 `{ mode: "single-page" }`；恰好 50 条时，严格定位官方用量区的第二个分页按钮：

  ```ts
  const paginationButtons = page.locator(
    '[data-slot="usage-table"] [data-slot="pagination"] > button'
  );
  if (await paginationButtons.count() !== 2) {
    throw new Error("未找到唯一的 usage 分页控件");
  }
  const page1Promise = waitForUsageListPage(
    page,
    workspaceId,
    signal,
    (candidate) => JSON.stringify(candidate.request) !== JSON.stringify(page0.request)
  );
  await paginationButtons.nth(1).click({ timeout: 10_000, signal });
  const page1 = await page1Promise;
  ```

  第一页允许 0 至 50 条；模板必须分别逐字节还原捕获的第 0/1 页请求。最终调用 `parseSessionBundle(JSON.stringify(candidate))` 生成版本 2，Cookie 仍只来自 `context.cookies(OPENCODE_ORIGIN)`；浏览器关闭后沿用现有 `finally` 删除临时 profile。

  ```ts
  export function buildSessionBundle(
    workspaceId: string,
    authCookie: string,
    goRequest: OpenCodeRequestDescriptor,
    usageList: OpenCodeSessionBundleV2["usageList"]
  ): OpenCodeSessionBundleV2 {
    return parseSessionBundle(JSON.stringify({
      version: 2,
      generation: randomUUID(),
      createdAt: new Date().toISOString(),
      workspaceId,
      auth: { cookie: "auth=" + authCookie },
      goRequest,
      usageList
    })) as OpenCodeSessionBundleV2;
  }
  ```

- [ ] **步骤 5：实现 `--version-only` 且把 Node 测试纳入检查**

  ```ts
  export type UploadMode = "deployed" | "version-only";

  export function parseAuthSetupArgs(
    argv: readonly string[]
  ): { uploadMode: UploadMode } {
    if (argv.length === 0) return { uploadMode: "deployed" };
    if (argv.length === 1 && argv[0] === "--version-only") {
      return { uploadMode: "version-only" };
    }
    throw new Error("仅支持可选参数 --version-only");
  }

  export function buildWranglerSecretArgs(
    wranglerCli: string,
    mode: UploadMode
  ): string[] {
    return mode === "version-only"
      ? [wranglerCli, "versions", "secret", "put", "OPENCODE_SESSION_BUNDLE"]
      : [wranglerCli, "secret", "put", "OPENCODE_SESSION_BUNDLE"];
  }
  ```

  保留现有 stdin 传 Secret、30 秒超时、取消时 kill 并等待 close 的行为。`package.json` 增加：

  ```json
  {
    "scripts": {
      "test:auth": "tsx --test scripts/auth-setup.test-node.ts",
      "check": "npm run typecheck && npm test && npm run test:auth"
    }
  }
  ```

- [ ] **步骤 6：运行授权测试并提交**

  ```powershell
  npm run test:auth
  npx vitest run test/opencode-session-bundle.test.ts test/opencode-usage.test.ts test/opencode-usage-source.test.ts
  npm run typecheck
  git diff --check
  git add scripts/opencode-usage-capture.ts scripts/auth-setup.ts scripts/auth-setup.test-node.ts package.json
  git commit -m "升级用量会话授权工具"
  ```

  预期：授权 Node 测试全部通过；测试输出不出现 Cookie、请求体或完整会话包；`--version-only` 只创建未部署 Worker 版本。

---

### 任务 4：聚合 24 小时明细并渲染文字消息

**文件：**

- 修改：`src/usage-domain.ts`
- 新建：`src/usage-aggregate.ts`
- 新建测试：`test/usage-aggregate.test.ts`
- 修改：`src/rules.ts`
- 修改测试：`test/rules.test.ts`

**接口：**

- 消费：任务 1 的 `UsageRecord` 和任务 2 的 complete/truncated 结果。
- 产出：`aggregateUsage24h(records, observedAt, truncated): UsageAggregate`。
- 产出：`UsageDetailsView` 判别联合。
- 修改：`renderBroadcastMessage(snapshot, eventId, manual, usageDetails?): RenderedMessage`；第四参数暂设安全默认值，任务 7 再由运行时显式传入。

- [ ] **步骤 1：写北京时间边界、口径和排行失败测试**

  固定观察时间 `2026-08-05T03:30:00.000Z`（北京时间 11:30），断言桶从北京时间前一天 12:00 至当天 11:00，窗口起点包含、观察时间之后和起点之前排除，四类总量不重复计算，前五外合并“其他”：

  ```ts
  function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
    return {
      id: "use_base",
      occurredAt: Date.parse("2026-08-05T03:00:00.000Z"),
      provider: "anthropic",
      model: "claude-sonnet",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      costMicroCents: 0,
      ...overrides
    };
  }

  it("生成二十四个北京时间小时桶并使用四类 Token 口径", () => {
    const aggregate = aggregateUsage24h([
      usage({
        id: "boundary",
        occurredAt: Date.parse("2026-08-04T04:00:00.000Z"),
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWrite5mTokens: 5,
        cacheWrite1hTokens: 6,
        costMicroCents: 100000000
      })
    ], Date.parse("2026-08-05T03:30:00.000Z"), false);
    expect(aggregate.buckets).toHaveLength(24);
    expect(aggregate.windowStartAt).toBe(Date.parse("2026-08-04T04:00:00.000Z"));
    expect(aggregate.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheTokens: 15,
      totalTokens: 48
    });
    expect(aggregate.costMicroCents).toBe(100000000);
  });
  ```

  `test/rules.test.ts` 另断言恶意模型名被转义、truncated 数值出现“至少”、合法零记录显示零、无授权不出现 `<img>`、有 `chartUrl` 时只出现一个外链图。

- [ ] **步骤 2：运行聚合与消息测试并确认失败**

  ```powershell
  npx vitest run test/usage-aggregate.test.ts test/rules.test.ts
  ```

  预期：因 `aggregateUsage24h`、`UsageAggregate` 和扩展消息参数尚不存在而失败。

- [ ] **步骤 3：实现统一聚合类型与 24 小时计算**

  在 `src/usage-domain.ts` 追加：

  ```ts
  export interface UsageTokenTotals {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheTokens: number;
    totalTokens: number;
  }

  export interface UsageHourBucket {
    startAt: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheTokens: number;
  }

  export interface UsageModelTotal {
    model: string;
    tokenCount: number;
    sharePercent: number;
  }

  export interface UsageAggregate {
    observedAt: number;
    windowStartAt: number;
    truncated: boolean;
    requestCount: number;
    costMicroCents: number;
    tokens: UsageTokenTotals;
    buckets: UsageHourBucket[];
    models: UsageModelTotal[];
  }

  export type UsageUnavailableReason =
    | "not-authorized"
    | "single-page-full"
    | "auth"
    | "transient"
    | "schema";

  export type UsageDetailsView =
    | { status: "available"; aggregate: UsageAggregate; chartUrl?: string }
    | { status: "unavailable"; reason: UsageUnavailableReason };
  ```

  `aggregateUsage24h` 用固定 UTC+8 算小时起点：

  ```ts
  const HOUR_MS = 60 * 60 * 1000;
  const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

  function shanghaiHourStart(timestamp: number): number {
    return Math.floor((timestamp + SHANGHAI_OFFSET_MS) / HOUR_MS) * HOUR_MS -
      SHANGHAI_OFFSET_MS;
  }

  const currentHourStart = shanghaiHourStart(observedAt);
  const windowStartAt = currentHourStart - 23 * HOUR_MS;
  ```

  先创建 24 个零桶，再汇总范围内记录。模型按 `tokenCount` 降序、`model.localeCompare` 升序；最多保留前五，剩余汇总为“其他”；占比在总 Token 为零时为零，否则保存未格式化百分比，渲染阶段显示一位小数。

- [ ] **步骤 4：按固定顺序扩展广播 HTML**

  `renderBroadcastMessage` 的第四参数默认 `{ status: "unavailable", reason: "not-authorized" }`，按“三项额度、请求/总 Token、四分类、费用、模型排行、可选图表、观察时间/部分小时/事件编号”顺序拼接。可用但无图时增加“图表暂不可用，文字汇总不受影响”；不可用原因使用固定中文而不回显异常：

  ```ts
  function escapeHtmlText(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  const escapeHtmlAttribute = escapeHtmlText;

  const USAGE_UNAVAILABLE_COPY: Record<UsageUnavailableReason, string> = {
    "not-authorized": "24 小时明细尚未授权，请重新运行授权工具。",
    "single-page-full": "24 小时明细分页尚未授权，请重新运行授权工具。",
    auth: "24 小时明细登录已失效，请重新运行授权工具。",
    transient: "24 小时明细暂时不可用，本次额度数据不受影响。",
    schema: "24 小时明细格式已变化，请更新采集适配器。"
  };

  const chart = usageDetails.status === "available" && usageDetails.chartUrl
    ? '<br><img src="' + escapeHtmlAttribute(usageDetails.chartUrl) +
      '" alt="最近 24 小时 Token 分层图" style="max-width:100%;height:auto">'
    : "";
  ```

  所有模型名经 `escapeHtmlText`；整数使用 `new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 })`，费用使用 `(costMicroCents / 100000000).toFixed(4)`，模型占比使用 `sharePercent.toFixed(1) + "%"`。截断时请求数、Token、费用和模型数值统一用“至少”修饰，图表说明“仅含已采集的最新记录”。

- [ ] **步骤 5：运行定向测试并提交**

  ```powershell
  npx vitest run test/usage-aggregate.test.ts test/rules.test.ts
  npm run typecheck
  git diff --check
  git add src/usage-domain.ts src/usage-aggregate.ts test/usage-aggregate.test.ts src/rules.ts test/rules.test.ts
  git commit -m "增加二十四小时用量汇总"
  ```

  预期：24 桶、边界、零数据、费用、前五加“其他”、HTML 转义和降级文案测试通过。

---

### 任务 5：原子保存、读取并清理图表快照

**文件：**

- 新建：`migrations/0005_usage_chart_snapshots.sql`
- 修改：`src/repository.ts`
- 修改测试：`test/repository.test.ts`
- 修改测试：`test/app.test.ts`

**接口：**

- 产出：`UsageChartSnapshotWrite`、`UsageChartSnapshotRow`。
- 修改：`SnapshotCommit` 新增必填 `usageChartSnapshots: UsageChartSnapshotWrite[]`。
- 产出：`Repository.loadUsageChartSnapshot(id): Promise<UsageChartSnapshotRow | null>`。
- 产出：`Repository.deleteExpiredUsageChartSnapshots(cutoff, limit?): Promise<number>`。

- [ ] **步骤 1：写事务回滚、读取和限量清理失败测试**

  扩展现有租约原子提交测试，活租约时 state、event、snapshot、job 同时存在；失租约时四者均不存在；用非法 `chartJson` 触发 CHECK 后整批不落库。再插入 201 条过期快照，断言一次只删 200 条：

  ```ts
  await repository.commitSnapshotUnderLease({
    owner: "owner-live",
    now,
    jobKey: "job-live",
    jobStatus: "succeeded",
    states: [],
    events: [{
      id: "a".repeat(64),
      logicalKey: "broadcast:scheduled:2026-08-05:11",
      kind: "daily",
      title: "用量",
      content: "内容",
      notAfter: now + 60_000,
      triggers: []
    }],
    usageChartSnapshots: [{
      id: "a".repeat(64),
      observedAt: now,
      chartJson: JSON.stringify({ version: 1, observedAt: now, truncated: false, buckets: [] }),
      createdAt: now
    }]
  });
  expect(await repository.loadUsageChartSnapshot("a".repeat(64)))
    .toEqual(expect.objectContaining({ id: "a".repeat(64) }));
  ```

  两个共享 D1 测试的 `beforeEach` 都先执行 `DELETE FROM usage_chart_snapshots`，再清理 `outbox_events`。

- [ ] **步骤 2：运行仓储测试并确认表和接口缺失**

  ```powershell
  npx vitest run test/repository.test.ts
  ```

  预期：迁移表、`usageChartSnapshots` 和读取/清理方法不存在导致失败。

- [ ] **步骤 3：增加不可变迁移**

  `migrations/0005_usage_chart_snapshots.sql` 内容固定为：

  ```sql
  CREATE TABLE usage_chart_snapshots (
    id TEXT PRIMARY KEY
      REFERENCES outbox_events(id) ON DELETE CASCADE,
    observed_at INTEGER NOT NULL,
    chart_json TEXT NOT NULL CHECK (json_valid(chart_json)),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX usage_chart_snapshots_created
  ON usage_chart_snapshots (created_at, id);
  ```

- [ ] **步骤 4：把快照放入同一受租约保护的 D1 batch**

  在 `src/repository.ts` 增加：

  ```ts
  export interface UsageChartSnapshotWrite {
    id: string;
    observedAt: number;
    chartJson: string;
    createdAt: number;
  }

  export interface UsageChartSnapshotRow extends UsageChartSnapshotWrite {}
  ```

  快照 INSERT helper 固定为：

  ```ts
  private usageChartInsertStatements(
    owner: string,
    now: number,
    snapshots: UsageChartSnapshotWrite[]
  ): D1PreparedStatement[] {
    const guard =
      "EXISTS (SELECT 1 FROM locks WHERE name = 'snapshot' " +
      "AND owner = ? AND lease_until > ?)";
    return snapshots.map((snapshot) => this.db.prepare(
      "INSERT OR IGNORE INTO usage_chart_snapshots " +
      "(id, observed_at, chart_json, created_at) " +
      "SELECT ?, ?, ?, ? WHERE " + guard + " " +
      "AND EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)"
    ).bind(
      snapshot.id,
      snapshot.observedAt,
      snapshot.chartJson,
      snapshot.createdAt,
      owner,
      now,
      snapshot.id
    ));
  }
  ```

  `commitSnapshotUnderLease` 先追加发件箱 INSERT，再执行 `statements.push(...this.usageChartInsertStatements(input.owner, input.now, input.usageChartSnapshots))`，最后更新 job；D1 `batch()` 保持唯一事务边界，首条 guard 无变化。所有现有调用点显式传 `usageChartSnapshots: []`，避免默认值掩盖遗漏。

- [ ] **步骤 5：实现读取和每次最多 200 条清理**

  ```ts
  async deleteExpiredUsageChartSnapshots(
    cutoff: number,
    limit = 200
  ): Promise<number> {
    const boundedLimit = Math.min(200, Math.max(0, Math.trunc(limit)));
    if (boundedLimit === 0) return 0;
    const result = await this.db.prepare(
      "DELETE FROM usage_chart_snapshots WHERE id IN (" +
      "SELECT id FROM usage_chart_snapshots WHERE created_at < ? " +
      "ORDER BY created_at, id LIMIT ?)"
    ).bind(cutoff, boundedLimit).run();
    return result.meta.changes;
  }
  ```

  `loadUsageChartSnapshot` 只按绑定参数查询 `id, observed_at, chart_json, created_at` 并映射 camelCase，不解析 JSON。

- [ ] **步骤 6：运行仓储回归并提交**

  ```powershell
  npx vitest run test/repository.test.ts test/app.test.ts
  npm run typecheck
  git diff --check
  git add migrations/0005_usage_chart_snapshots.sql src/repository.ts test/repository.test.ts test/app.test.ts
  git commit -m "原子保存用量图表快照"
  ```

  预期：事务成功/回滚和 200 条清理通过，现有发件箱、租约、幂等测试无回归。

---

### 任务 6：增加签名 SVG 图表、严格读取路由和配置

**文件：**

- 新建：`src/usage-chart.ts`
- 新建测试：`test/usage-chart.test.ts`
- 修改：`src/usage-domain.ts`
- 修改：`src/config.ts`
- 修改测试：`test/config-source.test.ts`
- 修改：`src/index.ts`
- 修改：`wrangler.jsonc`
- 修改：`.dev.vars.example`
- 修改：`vitest.config.ts`
- 生成：`worker-configuration.d.ts`

**接口：**

- 消费：任务 4 的 `UsageHourBucket`，任务 5 的 `Repository.loadUsageChartSnapshot`。
- 产出：`UsageChartDataV1`、`serializeUsageChartData(aggregate): string`、`parseUsageChartDataV1(raw): UsageChartDataV1`。
- 产出：`createUsageChartUrl(config, snapshotId): Promise<string>`、`handleUsageChartRequest(request, config, repository): Promise<Response>`。
- 修改：`AppConfig.usageChart = { publicBaseUrl: string; signingSecret: string }`。

- [ ] **步骤 1：写签名、篡改、SVG 和路由失败测试**

  覆盖正确 64 位小写十六进制编号、URL-safe 43 字符签名、编号或签名篡改、重复/额外 query、非 GET、Cookie/Authorization、未知快照、损坏 JSON 的统一 404，以及成功响应的四个安全头：

  ```ts
  const config: UsageChartConfig = {
    publicBaseUrl: "https://usage-chart.example.test",
    signingSecret: "test-usage-chart-signing-secret-32-bytes-minimum"
  };

  function validChartJson(): string {
    const first = Date.parse("2026-08-04T04:00:00.000Z");
    return JSON.stringify({
      version: 1,
      observedAt: Date.parse("2026-08-05T03:30:00.000Z"),
      truncated: false,
      buckets: Array.from({ length: 24 }, (_, index) => ({
        startAt: first + index * 60 * 60 * 1000,
        inputTokens: index,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheTokens: 0
      }))
    });
  }

  function readerWith(id: string, chartJson: string): UsageChartSnapshotReader {
    return {
      async loadUsageChartSnapshot(requestedId) {
        return requestedId === id ? {
          id,
          observedAt: Date.parse("2026-08-05T03:30:00.000Z"),
          chartJson,
          createdAt: Date.parse("2026-08-05T03:30:00.000Z")
        } : null;
      }
    };
  }

  it("只向合法签名返回安全 SVG", async () => {
    const id = "b".repeat(64);
    const url = await createUsageChartUrl(config, id);
    const response = await handleUsageChartRequest(
      new Request(url),
      config,
      readerWith(id, validChartJson())
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("content-security-policy"))
      .toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.text()).toContain("<svg");
  });
  ```

  配置测试断言公开地址拒绝 HTTP、凭据、路径、查询、片段和非标准端口，签名 Secret 少于 32 字符时拒绝加载。

- [ ] **步骤 2：运行图表与配置测试并确认失败**

  ```powershell
  npx vitest run test/usage-chart.test.ts test/config-source.test.ts
  ```

  预期：图表模块、配置绑定和路由尚不存在导致失败。

- [ ] **步骤 3：实现版本化图表数据和固定 SVG**

  在 `usage-domain.ts` 增加：

  ```ts
  export interface UsageChartDataV1 {
    version: 1;
    observedAt: number;
    truncated: boolean;
    buckets: UsageHourBucket[];
  }
  ```

  `src/usage-chart.ts` 对仓储只依赖以下最小读取接口，生产传入 `Repository`，测试传入内存 reader：

  ```ts
  export interface UsageChartSnapshotReader {
    loadUsageChartSnapshot(id: string): Promise<UsageChartSnapshotRow | null>;
  }
  ```

  `serializeUsageChartData` 只复制 `observedAt`、`truncated` 和严格 24 项 buckets。`parseUsageChartDataV1` 校验精确字段、24 个连续整点、全部非负安全整数。`renderUsageChartSvg` 使用固定 `720×360` 画布、24 根堆叠柱、最大桶自动缩放和每 3 小时标签；小时标签通过 `Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" })` 生成。层顺序、固定中文图例和颜色为输入 `#2563eb`、输出 `#16a34a`、推理 `#7c3aed`、缓存 `#f59e0b`。最大值为零时用 1 作为除数，所有柱高保持零；观察时间和截断说明经 XML 转义。

  核心 SVG 几何固定如下，不引入图表依赖：

  ```ts
  function escapeXml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  export function renderUsageChartSvg(data: UsageChartDataV1): string {
    const left = 52;
    const top = 72;
    const plotWidth = 648;
    const plotHeight = 220;
    const slotWidth = plotWidth / 24;
    const barWidth = slotWidth - 6;
    const totals = data.buckets.map((bucket) =>
      bucket.inputTokens + bucket.outputTokens +
      bucket.reasoningTokens + bucket.cacheTokens
    );
    const maximum = Math.max(1, ...totals);
    const hourFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hourCycle: "h23"
    });
    const observedFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    const layers = [
      ["inputTokens", "#2563eb"],
      ["outputTokens", "#16a34a"],
      ["reasoningTokens", "#7c3aed"],
      ["cacheTokens", "#f59e0b"]
    ] as const;
    const bars = data.buckets.map((bucket, index) => {
      const x = left + index * slotWidth + 3;
      let y = top + plotHeight;
      const rectangles = layers.map(([field, color]) => {
        const height = bucket[field] / maximum * plotHeight;
        y -= height;
        return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
          `width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" ` +
          `fill="${color}"/>`;
      }).join("");
      const label = index % 3 === 0
        ? `<text x="${(x + barWidth / 2).toFixed(2)}" y="310" ` +
          `text-anchor="middle" font-size="11">` +
          escapeXml(hourFormatter.format(new Date(bucket.startAt))) + `</text>`
        : "";
      return rectangles + label;
    }).join("");
    const note = (data.truncated
      ? "仅含已采集的最新记录"
      : "当前小时为部分小时") +
      "；观察于 " + observedFormatter.format(new Date(data.observedAt));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360" ` +
      `role="img" aria-label="最近 24 小时 Token 分层图">` +
      `<rect width="720" height="360" fill="#ffffff"/>` +
      `<text x="24" y="30" font-size="18" font-weight="700">最近 24 小时 Token</text>` +
      `<text x="52" y="62" font-size="11">最大每小时 ${maximum}</text>` +
      `<line x1="52" y1="292" x2="700" y2="292" stroke="#94a3b8"/>` +
      bars +
      `<text x="24" y="338" font-size="11">` + escapeXml(note) + `</text>` +
      `<g font-size="11">` +
      `<text x="400" y="30" fill="#2563eb">■ 输入</text>` +
      `<text x="470" y="30" fill="#16a34a">■ 输出</text>` +
      `<text x="540" y="30" fill="#7c3aed">■ 推理</text>` +
      `<text x="610" y="30" fill="#f59e0b">■ 缓存</text>` +
      `</g></svg>`;
  }
  ```

- [ ] **步骤 4：实现 HMAC 地址与常量时间验签**

  HMAC payload 固定为 UTF-8 `usage-chart:v1:<snapshotId>`，签名使用 SHA-256 和无填充 Base64URL：

  ```ts
  function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  }

  function fromBase64Url(value: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
    try {
      const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
      const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return bytes.byteLength === 32 && toBase64Url(bytes) === value ? bytes : null;
    } catch {
      return null;
    }
  }

  export async function signUsageChart(
    secret: string,
    snapshotId: string
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/u.test(snapshotId)) {
      throw new Error("图表快照编号无效");
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const bytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode("usage-chart:v1:" + snapshotId)
    );
    return toBase64Url(new Uint8Array(bytes));
  }

  export async function verifyUsageChartSignature(
    secret: string,
    snapshotId: string,
    signature: string
  ): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/u.test(snapshotId)) return false;
    const signatureBytes = fromBase64Url(signature);
    if (signatureBytes === null) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode("usage-chart:v1:" + snapshotId)
    );
  }
  ```

  验签先严格解码为 32 字节，再用导入为 `verify` 用途的 HMAC key 调用 `crypto.subtle.verify`；不得用普通字符串相等比较。

- [ ] **步骤 5：实现统一 404 的图表 HTTP 契约**

  `handleUsageChartRequest` 必须先拒绝非 GET、Cookie、Authorization、非精确路径、非唯一 `sig` 和任何额外 query，再验签，最后读 D1。非法签名、未知编号、损坏快照和渲染异常统一返回空 404；成功响应：

  ```ts
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=3600"
    }
  });
  ```

  `src/index.ts` 的顺序固定为手动入口、`/charts/usage/` GET、PushPlus callback、404；图表路径必须位于 callback 的 POST 通用门禁之前。

- [ ] **步骤 6：增加生产/预览配置并生成类型**

  `wrangler.jsonc` 增加：

  ```jsonc
  "preview_urls": true,
  "vars": {
    "PUBLIC_BASE_URL": "https://opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev"
  },
  "secrets": {
    "required": ["USAGE_CHART_SIGNING_SECRET"]
  }
  ```

  上述数组和对象应与现有项合并，不能覆盖旧值。`loadConfig` 保存 `new URL(PUBLIC_BASE_URL).origin`，只允许无凭据、无 path/query/hash、标准端口的 HTTPS origin；`.dev.vars.example` 和 `vitest.config.ts` 使用 `test-usage-chart-signing-secret-32-bytes-minimum`。运行：

  ```powershell
  npm run typegen
  ```

- [ ] **步骤 7：运行图表回归并提交**

  ```powershell
  npx vitest run test/usage-chart.test.ts test/config-source.test.ts
  npm run typecheck
  git diff --check
  git add src/usage-chart.ts test/usage-chart.test.ts src/usage-domain.ts src/config.ts test/config-source.test.ts src/index.ts wrangler.jsonc .dev.vars.example vitest.config.ts worker-configuration.d.ts
  git commit -m "增加签名用量图表接口"
  ```

  预期：合法 SVG、篡改 404、安全响应头、配置约束和类型生成全部通过。

---

### 任务 7：把明细、文字降级和图表事务接入广播主链路

**文件：**

- 修改：`src/app.ts`
- 修改测试：`test/app.test.ts`
- 修改测试：`test/pushplus.test.ts`

**接口：**

- 消费：`createUsageDetailsSource`、`aggregateUsage24h`、`renderBroadcastMessage`、`createUsageChartUrl`、`serializeUsageChartData` 和带快照的 `SnapshotCommit`。
- 修改：`AppDeps` 增加 `usageSource?: UsageDetailsSource`。
- 修改：`newEvent(..., render: (eventId) => RenderedMessage | Promise<RenderedMessage>, ...): Promise<NewOutboxEvent>`。
- 保持：`runBroadcast(trigger, env, deps?): Promise<BroadcastResult>`、整点键、手动幂等键和 PushPlus 投递契约不变。

- [ ] **步骤 1：写端到端降级和共享主路径失败测试**

  在 `test/app.test.ts` 只增加以下高价值路径：

  - 定时 `/go` 与 `/usage` 成功：一个事件和一个同编号快照原子存在，HTML 含汇总、排行和签名 `<img>`。
  - 手动成功：复用相同聚合/快照链路，重复幂等键仍只投递一次。
  - `/usage` 抛 auth/transient/schema：任务仍 `completed`，三项额度存在，无 `<img>`、无快照，且不写 `/go` 的 auth fault episode。
  - 合法空数组：显示零汇总并保存零值图表。
  - 明细采集期间越过 scheduled `notAfter`：旧整点标记 skipped，不创建事件或快照。
  - 图表事务因非法 JSON 失败：用同一事件编号重试文字明细且没有 `<img>`；`LeaseLostError` 不重试。

  核心断言：

  ```ts
  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM usage_chart_snapshots WHERE id = ?"
  ).bind(eventId).first()).toEqual({ count: 1 });
  expect(event.content).toContain("最近 24 小时");
  expect(event.content).toContain(`/charts/usage/${eventId}.svg?sig=`);
  ```

  `test/pushplus.test.ts` 把 content 设为含 `<img>` 的 HTML，断言发送 JSON 中 `template === "html"` 且 content 逐字不变。

- [ ] **步骤 2：运行应用与投递测试并确认失败**

  ```powershell
  npx vitest run test/app.test.ts test/pushplus.test.ts
  ```

  预期：应用尚未调用明细来源、未生成快照，新增端到端断言失败。

- [ ] **步骤 3：在 `/go` 成功后独立采集并聚合 `/usage`**

  `AppDeps` 和默认来源：

  ```ts
  export interface AppDeps {
    source?: QuotaSource;
    usageSource?: UsageDetailsSource;
    fetchImpl?: typeof fetch;
    sourceFetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  }

  const usageSource = deps.usageSource ?? createUsageDetailsSource(
    config,
    deps.sourceFetchImpl,
    clock
  );
  ```

  保持现有 `/go` 重试与 fault catch 完整不动；仅在 `/go` 成功和第一次 scheduled 过期检查之后，用局部 `try/catch` 获取 `UsageCollectionResult`。complete/truncated 调用 `aggregateUsage24h`；unavailable 直接映射；抛出的 `SourceError.kind` 映射为 auth/transient/schema，未知异常映射 transient。日志只记录阶段、类别、工作区哈希和事件编号。

  ```ts
  let usageView: UsageDetailsView;
  try {
    const collected = await usageSource.fetch(observedAt);
    usageView = collected.status === "unavailable"
      ? { status: "unavailable", reason: collected.reason }
      : {
          status: "available",
          aggregate: aggregateUsage24h(
            collected.records,
            observedAt,
            collected.status === "truncated"
          )
        };
  } catch (error) {
    const reason: UsageUnavailableReason =
      error instanceof SourceError &&
      (error.kind === "auth" || error.kind === "transient" || error.kind === "schema")
        ? error.kind
        : "transient";
    usageView = { status: "unavailable", reason };
  }
  ```

- [ ] **步骤 4：在慢明细之后再次执行整点过期门禁**

  ```ts
  if (
    trigger.type === "scheduled" &&
    scheduledNotAfter !== undefined &&
    clock() >= scheduledNotAfter
  ) {
    await repo.commitSnapshotUnderLease({
      owner,
      now: clock(),
      jobKey,
      jobStatus: "skipped",
      errorKind: "expired-slot",
      states,
      events: [],
      usageChartSnapshots: []
    });
    return "completed";
  }
  ```

  该门禁必须位于明细采集之后、确定性事件编号和任何图表快照创建之前；手动广播不受影响。

- [ ] **步骤 5：生成同编号的文字事件、图表事件和快照**

  把现有故障恢复消息单独收集为 `const recoveryEvents: NewOutboxEvent[] = []`，恢复循环只向该数组追加；目标广播不再混入该数组。先生成 `textOnlyEvent`，可用明细再尝试生成 URL、rich event 和快照；`newEvent` 对 render 结果执行 `await`。快照编号必须等于确定性 event ID：

  ```ts
  const textOnlyEvent = await newEvent(
    "daily",
    logicalKey,
    (eventId) => renderBroadcastMessage(snapshot, eventId, manual, usageView),
    notAfter,
    []
  );

  let targetEvent = textOnlyEvent;
  let usageChartSnapshots: UsageChartSnapshotWrite[] = [];
  if (usageView.status === "available") {
    try {
      const chartUrl = await createUsageChartUrl(
        config.usageChart,
        textOnlyEvent.id
      );
      const richUsageView: UsageDetailsView = {
        status: "available",
        aggregate: usageView.aggregate,
        chartUrl
      };
      targetEvent = await newEvent(
        "daily",
        logicalKey,
        (eventId) => renderBroadcastMessage(snapshot, eventId, manual, richUsageView),
        notAfter,
        []
      );
      usageChartSnapshots = [{
        id: targetEvent.id,
        observedAt: usageView.aggregate.observedAt,
        chartJson: serializeUsageChartData(usageView.aggregate),
        createdAt: clock()
      }];
    } catch {
      targetEvent = textOnlyEvent;
      usageChartSnapshots = [];
    }
  }
  ```

  签名或序列化失败直接保留 `textOnlyEvent`；不可用明细不调用图表函数。

- [ ] **步骤 6：实现同事务提交和安全文字回退**

  rich 分支先把现有 states/recovery events、rich event 和 chartSnapshot 交给一个 `commitSnapshotUnderLease`。捕获非 `LeaseLostError` 时，因 D1 batch 已整批回滚，用相同 owner、job、states、recovery events 和同编号 `textOnlyEvent` 再提交一次，`usageChartSnapshots: []`；`LeaseLostError` 直接交给现有失租约流程。第二次失败沿用现有内部故障收尾，不发送未提交内容。

  ```ts
  const commitNow = clock();
  const commonCommit = {
    owner,
    now: commitNow,
    jobKey,
    jobStatus: "succeeded" as const,
    states: [
      { key: "quota", value: evaluation.state, version: commitNow },
      { key: "runtime", value: runtime, version: commitNow }
    ]
  };

  try {
    await repo.commitSnapshotUnderLease({
      ...commonCommit,
      events: [...recoveryEvents, targetEvent],
      usageChartSnapshots
    });
  } catch (error) {
    if (error instanceof LeaseLostError || usageChartSnapshots.length === 0) {
      throw error;
    }
    await repo.commitSnapshotUnderLease({
      ...commonCommit,
      events: [...recoveryEvents, textOnlyEvent],
      usageChartSnapshots: []
    });
  }
  ```

  运行结束的最外层 `finally` 单独尝试：

  ```ts
  await repo.deleteExpiredUsageChartSnapshots(clock() - 30 * 24 * 60 * 60 * 1000, 200);
  ```

  清理异常只写脱敏结构化日志，不能覆盖广播结果，也不能阻止 `dispatchDue`。

- [ ] **步骤 7：确认 PushPlus 原样投递并提交**

  `src/pushplus.ts` 继续发送：

  ```ts
  body: JSON.stringify({
    token: config.token,
    title: event.title,
    content: event.content,
    template: "html",
    topic: config.topic,
    callbackUrl
  })
  ```

  不在投递层重写、抓取或内联图片。运行并提交：

  ```powershell
  npx vitest run test/app.test.ts test/rules.test.ts test/pushplus.test.ts test/repository.test.ts
  npm run typecheck
  git diff --check
  git add src/app.ts test/app.test.ts test/pushplus.test.ts
  git commit -m "接入用量明细广播降级链路"
  ```

  预期：定时与手动主路径、空数据、失败降级、整点过期、事务回退和 HTML 原样投递全部通过。

---

### 任务 8：补全文档、全量验证、预览微信验收与中文 PR

**文件：**

- 修改：`README.md`
- 检查：本计划涉及的全部文件
- 外部状态：远程 D1 migration、Worker Secret、版本预览 alias、OpenCode 版本 2 会话包、微信消息、GitHub PR

**接口：**

- 生产根地址：`https://opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`。
- 预览 alias：`https://usage-chart-opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev`。
- `wrangler versions secret put` 只创建新版本，不移动 preview alias；写入版本 2会话后必须再次 `versions upload --preview-alias usage-chart`。
- 预览 alias 必须公开且不启用 Cloudflare Access，微信才能匿名读取带签名 SVG。

- [ ] **步骤 1：写完整中文运维文档**

  README 明确记录：消息字段顺序、24 小时/四类 Token/费用口径、版本 1 降级、单页满 50 条需重新授权、25 秒/40 页截断、两个新配置、签名链接的持有者可见性、D1 只存聚合桶、30 天保留、`/usage` 不阻断 `/go`、`npm run auth:setup -- --version-only` 的用途和下述预览验收顺序。不得写入任何真实 Secret、Cookie 或完整授权包。

- [ ] **步骤 2：执行一次完整但精简的自动验证**

  ```powershell
  npm run check
  git diff --check
  git status --short
  ```

  预期：TypeScript、Vitest 和 Node 授权测试全部通过；`package-lock.json` 无变化；状态中只有本功能与设计/计划文件。

- [ ] **步骤 3：提交文档和最终机械修正**

  ```powershell
  git add README.md worker-configuration.d.ts package.json wrangler.jsonc .dev.vars.example vitest.config.ts
  git commit -m "补充用量图表授权与发布说明"
  ```

  若这些文件已在前序提交完整提交且本步骤没有新差异，不创建空提交；用 `git status --short` 确认工作树干净。

- [ ] **步骤 4：按安全顺序准备远程预览**

  在同一个 PowerShell 会话中执行，两个 origin 值固定如下：

  ```powershell
  $productionOrigin = 'https://opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev'
  $previewOrigin = 'https://usage-chart-opencode-go-usage-broadcaster.opencode-go-usage-broadcaster.workers.dev'

  npx wrangler d1 migrations apply opencode-go-usage --remote

  $chartBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($chartBytes)
  $chartSecret = [Convert]::ToBase64String($chartBytes)
  $chartSecret | npx wrangler secret put USAGE_CHART_SIGNING_SECRET
  $chartSecret = $null

  npx wrangler versions upload --dry-run

  npx wrangler versions upload `
    --preview-alias usage-chart `
    --tag usage-chart-preview-base `
    --var "PUBLIC_BASE_URL:$previewOrigin"
  ```

  图表 Secret 必须在首次 version upload 前设置；普通 `secret put` 此时只让旧生产代码多一个未使用的 Secret。迁移与 Secret 命令输出只核对成功状态，不输出敏感值。

- [ ] **步骤 5：生成版本 2 会话并把 alias 移到含新 Secret 的版本**

  ```powershell
  npm run auth:setup -- --version-only

  npx wrangler versions upload `
    --preview-alias usage-chart `
    --tag usage-chart-preview-ready `
    --var "PUBLIC_BASE_URL:$previewOrigin"

  npx wrangler versions secret list --latest-version
  ```

  授权时用户只完成一次 GitHub 登录；工具依次访问 `/go`、`/usage`，捕获完成后自动关闭并删除临时 profile。两次 upload 之间暂停 CI 和其他发布，第二次命令必须再次传预览 `PUBLIC_BASE_URL`；Secret 列表只核对名称中包含 `OPENCODE_SESSION_BUNDLE` 与 `USAGE_CHART_SIGNING_SECRET`。

- [ ] **步骤 6：执行真实微信门槛测试**

  在同一 PowerShell 会话用安全输入读取现有 `MANUAL_TRIGGER_SECRET`，不回显、不写文件；然后请求预览而不是 GitHub 生产工作流：

  ```powershell
  $manualSecure = Read-Host '请输入现有 MANUAL_TRIGGER_SECRET' -AsSecureString
  $manualSecret = [Net.NetworkCredential]::new('', $manualSecure).Password
  $idempotencyKey = 'manual-preview-' + [guid]::NewGuid().ToString('N')
  $response = Invoke-WebRequest `
    -Method Post `
    -Uri "$previewOrigin/admin/manual-trigger" `
    -Headers @{
      Authorization = "Bearer $manualSecret"
      'Idempotency-Key' = $idempotencyKey
    }
  $manualSecret = $null
  if ($response.StatusCode -ne 204) {
    throw "预览手动广播未返回 204"
  }
  ```

  用户在微信点开本条 PushPlus 详情，必须确认三项额度、24 小时文字汇总、模型排行和 SVG 均可见。SVG 不可见时停止生产发布，保留预览版本，回到设计决策选择新的图片渲染方案；不得临时接入第三方图表或声称验收通过。

- [ ] **步骤 7：推送分支并创建非草稿中文 PR**

  ```powershell
  git status --short
  git log --oneline master..HEAD
  git push -u origin codex/usage-details-chart
  gh pr create `
    --base master `
    --head codex/usage-details-chart `
    --title "增加 OpenCode 用量明细与图表广播" `
    --body "本次改动在现有三项 Go 额度后增加最近 24 小时 Token 汇总、模型排行和签名 SVG 图表；升级一次登录授权工具以捕获 usage.list 分页请求；明细或图表故障时仍发送额度或文字汇总。已通过完整检查、Wrangler 预览构建和真实微信详情页验收。"
  ```

  PR 正文只写真实已完成的验证；若微信门槛尚未通过，不执行此步骤并明确报告唯一阻塞项。

- [ ] **步骤 8：合并后再发布生产并核对下一整点**

  用户确认 PR 已合并后，在主分支更新代码并确认 `wrangler.jsonc` 仍是生产根地址，再执行：

  ```powershell
  git switch master
  git pull --ff-only
  npm run check
  npm run deploy
  ```

  核对部署输出仍只有 Cron `0 1-15 * * *`，然后观察下一次北京时间 09:00 至 23:00 整点消息；确认定时规则、手动幂等、三项额度、24 小时明细和脱敏日志均符合规格。
