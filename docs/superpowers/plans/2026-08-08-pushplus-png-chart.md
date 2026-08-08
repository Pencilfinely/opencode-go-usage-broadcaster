# PushPlus PNG 图表可靠推送实施计划

> **供代理执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务执行本计划。步骤使用复选框跟踪。

**目标：** 将新广播中的用量图表改为 Cloudflare Browser Run 生成的 720×360 PNG，并上传至 PushPlus 官方图片服务；所有图片故障自动降级为完整文字消息。

**架构：** 应用在现有广播租约内先创建确定性事件编号，再通过可注入的图片发布函数完成“SVG → PNG → PushPlus CDN”，最后把 CDN 地址固化到 outbox。历史签名 SVG 路由和快照表继续保留 30 天，但新广播不再写入 SVG 快照。图片发布与消息投递分离，因此消息重试不会重复截图或上传。

**技术栈：** TypeScript 7、Cloudflare Workers、Browser Run Quick Actions、D1、原生 `fetch`/`FormData`、Vitest Workers Pool、Wrangler 4。

## 全局约束

- 所有提交信息、PR 标题、PR 正文、代码注释和 GitHub 注释一律使用中文。
- 不增加运行时 npm 依赖；Browser Run 使用 `BROWSER` binding 和 `quickAction("screenshot", ...)`。
- `compatibility_date` 保持 `2026-08-03`，满足 Quick Action 要求的 `2026-03-24` 下限；不新增无必要的兼容标志。
- PNG 必须为 720×360、`image/png`、不超过 2 MiB；响应读取必须有界。
- PushPlus 开放接口的 Token、SecretKey、AccessKey、上传 Token、完整上传地址、完整图片地址和 PNG 字节不得进入日志或错误文本。
- `PUSHPLUS_SECRET_KEY` 只作为 Cloudflare Secret；现有 `PUSHPLUS_TOKEN` 必须是用户 Token。
- PushPlus 图片上传地址只允许精确的 `https://upload.qiniup.com/`；最终图片主机必须精确为 `pic.pushplus.plus`。
- 图片生成或上传失败时只发送完整文字消息，不回退到新 SVG 图片。
- 旧 `/charts/usage/*.svg` 路由、签名配置、快照表和 30 天清理逻辑保持不变，仅停止新写入。
- 测试精简到新风险：PNG 边界、上传契约、应用成功/降级/幂等；现有回归测试继续通过。

---

### Task 1：Browser Run PNG 渲染器

**文件：**

- 新建：`src/usage-chart-png.ts`
- 新建：`test/usage-chart-png.test.ts`
- 修改：`wrangler.jsonc`
- 生成：`worker-configuration.d.ts`

**接口：**

- 输入：现有 `UsageAggregate` 与 `Pick<BrowserRun, "quickAction">`。
- 输出：`renderUsageChartPng(browser, aggregate): Promise<RenderedUsageChartPng>`。
- 类型：

```ts
export interface RenderedUsageChartPng {
  bytes: Uint8Array;
  browserMs: number | null;
}

export class UsageChartPngError extends Error {
  constructor() {
    super("usage_chart_png_invalid");
    this.name = "UsageChartPngError";
  }
}

export async function renderUsageChartPng(
  browser: Pick<BrowserRun, "quickAction">,
  aggregate: UsageAggregate
): Promise<RenderedUsageChartPng>;
```

- 后续任务仅消费 `bytes`；`browserMs` 用于脱敏结构化日志。

- [ ] **步骤 1：先写成功路径失败测试**

在 `test/usage-chart-png.test.ts` 构造一个真实 `UsageAggregate` 和一个只实现 `quickAction` 的假 Browser binding。假响应返回手工构造的最小 720×360 PNG 头，断言：

```ts
const result = await renderUsageChartPng(browser, aggregate);

expect([...result.bytes.slice(0, 8)]).toEqual([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
expect(result.browserMs).toBe(321);
expect(receivedAction).toBe("screenshot");
expect(receivedOptions).toMatchObject({
  viewport: { width: 720, height: 360, deviceScaleFactor: 1 },
  selector: "body > svg",
  setJavaScriptEnabled: false,
  actionTimeout: 10_000,
  cacheTTL: 0,
  screenshotOptions: {
    type: "png",
    encoding: "binary",
    omitBackground: false
  }
});
expect(receivedOptions.html).toContain("最近 24 小时 Token");
expect(receivedOptions.html).toContain("default-src 'none'");
```

测试捕获的生产破坏：改错输出尺寸、启用 JavaScript、允许网络资源、遗漏 PNG 验证或未复用现有 SVG。

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：

```powershell
npx vitest run test/usage-chart-png.test.ts
```

预期：失败，原因是 `../src/usage-chart-png` 尚不存在。

- [ ] **步骤 3：实现最小 PNG 渲染器**

在 `src/usage-chart-png.ts`：

1. 通过 `parseUsageChartDataV1(serializeUsageChartData(aggregate))` 得到已校验图表数据，再调用 `renderUsageChartSvg`。
2. 将 SVG 放入固定 HTML，`body` 无边距、白底、尺寸 720×360；CSP 为 `default-src 'none'; style-src 'unsafe-inline'`。
3. 调用：

```ts
const response = await browser.quickAction("screenshot", {
  html,
  viewport: { width: 720, height: 360, deviceScaleFactor: 1 },
  selector: "body > svg",
  setJavaScriptEnabled: false,
  actionTimeout: 10_000,
  cacheTTL: 0,
  screenshotOptions: {
    type: "png",
    encoding: "binary",
    omitBackground: false
  }
});
```

4. 只接受 HTTP 200 和 `Content-Type` 以 `image/png` 开头。
5. 逐块读取响应流，累计超过 `2 * 1024 * 1024` 时取消 reader 并抛出固定错误 `usage_chart_png_invalid`。
6. 校验 PNG 8 字节魔数、首个 chunk 为 `IHDR`、宽 720、高 360；错误文本不得包含响应正文。
7. 从 `X-Browser-Ms-Used` 解析非负有限数，否则返回 `null`。

- [ ] **步骤 4：补充边界失败测试并先观察失败**

使用表驱动测试覆盖以下最小集合：

```ts
it.each([
  ["HTTP 失败", new Response("secret", { status: 429 })],
  ["MIME 错误", new Response(validPng, { headers: { "content-type": "text/plain" } })],
  ["PNG 魔数错误", new Response(new Uint8Array(32), { headers: { "content-type": "image/png" } })],
  ["PNG 尺寸错误", pngResponse(719, 360)]
])("拒绝%s", async (_name, response) => {
  await expect(renderUsageChartPng(browserReturning(response), aggregate))
    .rejects.toThrow("usage_chart_png_invalid");
});
```

再增加一个无 `Content-Length`、流式累计超过 2 MiB 的响应，确认 reader 被取消且固定错误中不出现 `secret`。

- [ ] **步骤 5：完成边界实现并运行渲染器测试**

运行：

```powershell
npx vitest run test/usage-chart-png.test.ts
```

预期：全部通过，无警告。

- [ ] **步骤 6：增加 Browser binding 并生成类型**

在 `wrangler.jsonc` 顶层增加：

```jsonc
"browser": {
  "binding": "BROWSER"
}
```

不配置 `remote: true`。运行：

```powershell
npm run typegen
npm run typecheck
```

预期：`worker-configuration.d.ts` 生成 `BROWSER: BrowserRun`，类型检查通过。

- [ ] **步骤 7：提交任务 1**

```powershell
git add src/usage-chart-png.ts test/usage-chart-png.test.ts wrangler.jsonc worker-configuration.d.ts
git commit -m "功能：生成可靠的用量 PNG 图表"
```

---

### Task 2：PushPlus 官方图片上传客户端与密钥配置

**文件：**

- 新建：`src/pushplus-image.ts`
- 新建：`test/pushplus-image.test.ts`
- 修改：`src/config.ts`
- 修改：`test/config-source.test.ts`
- 修改：`vitest.config.ts`
- 修改：`.dev.vars.example`
- 修改：`wrangler.jsonc`
- 生成：`worker-configuration.d.ts`

**接口：**

```ts
export interface PushPlusImageConfig {
  token: string;
  secretKey: string;
}

export type PushPlusImageStage = "access_key" | "upload_token" | "upload";

export class PushPlusImageError extends Error {
  constructor(
    public readonly stage: PushPlusImageStage,
    category: "network" | "rejected" | "invalid"
  ) {
    super(`pushplus_image_${stage}_${category}`);
    this.name = "PushPlusImageError";
  }
}

export async function uploadPushPlusPng(
  config: PushPlusImageConfig,
  png: Uint8Array,
  fetchImpl: typeof fetch = fetch
): Promise<string>;
```

- 输入 PNG 已由任务 1 验证；客户端仍独立复核魔数和 2 MiB 上限。
- 输出仅为严格验证后的 `https://pic.pushplus.plus/...` URL。

- [ ] **步骤 1：先写三步上传主路径失败测试**

假 `fetchImpl` 按顺序返回官方完整结构：

```ts
Response.json({
  code: 200,
  msg: "请求成功",
  data: { accessKey: "a".repeat(32), expiresIn: 7200 }
});

Response.json({
  code: 200,
  msg: "执行成功",
  data: {
    uploadToken: "upload-token",
    uploadHost: "https://upload.qiniup.com",
    uploadUrl: "https://upload.qiniup.com/",
    bucket: "pushplus-img",
    expiresIn: 600
  }
});

Response.json({
  errno: 0,
  ext: ".png",
  fname: "chart.png",
  fsize: validPng.byteLength,
  hash: "hash",
  key: "1/chart.png",
  mimeType: "image/png",
  msg: "ok",
  thumbnail: "https://pic.pushplus.plus/1/chart.png@s",
  url: "https://pic.pushplus.plus/1/chart.png@p"
});
```

断言真实边界契约：

- 第一次请求为固定 AccessKey 地址、POST、JSON `{token, secretKey}`、`redirect: "error"`。
- 第二次请求为固定上传凭证地址、GET、仅带 `access-key`。
- 第三次请求精确发往 `https://upload.qiniup.com/`、POST、`redirect: "error"`，body 是 `FormData`；`token` 字段等于上传 Token，`file` 是 `image/png` Blob，且没有手写 `content-type` 或 `access-key`。
- 返回值精确等于验证后的图片 URL。

测试捕获的生产破坏：请求顺序、鉴权头、multipart 字段、重定向策略或最终主机被改错。

- [ ] **步骤 2：运行测试并确认模块缺失失败**

```powershell
npx vitest run test/pushplus-image.test.ts
```

预期：失败，原因是 `../src/pushplus-image` 尚不存在。

- [ ] **步骤 3：实现最小安全客户端**

在 `src/pushplus-image.ts`：

1. 固定两个 PushPlus URL 和唯一七牛上传 URL，不接受调用方传入 URL。
2. 每个 PushPlus 凭证请求最长 8 秒，七牛上传最长 15 秒；用 `AbortController` 和 `finally clearTimeout`。
3. 所有 fetch 使用 `redirect: "error"`。
4. JSON 响应按 `Content-Length` 和流式累计双重限制在 64 KiB；只在有界字节上执行 `JSON.parse`。
5. AccessKey 响应要求 HTTP 2xx、`code === 200`、`accessKey` 为 32 至 512 字符、`expiresIn` 为正安全整数。
6. 上传凭证要求 HTTP 2xx、`code === 200`、`uploadToken` 非空且有界、`uploadUrl` 精确为 `https://upload.qiniup.com/`、`bucket` 非空、`expiresIn` 为正安全整数。
7. 先把 PNG 复制进独立 `ArrayBuffer`，再用 `new Blob([buffer], { type: "image/png" })` 加入 FormData，文件名固定 `usage-chart.png`；让运行时生成 multipart boundary，避免把 `ArrayBufferLike` 误传给 Blob。
8. 上传响应要求 HTTP 2xx、`errno === 0`、`mimeType === "image/png"`、`fsize === png.byteLength`，最终 URL 使用 HTTPS、无凭据、无非标准端口、hostname 精确为 `pic.pushplus.plus`。
9. 所有失败统一抛出固定前缀错误，例如 `pushplus_image_access_rejected`、`pushplus_image_token_invalid`、`pushplus_image_upload_invalid`；不得拼入上游正文、`msg`、URL 或任何凭据。

- [ ] **步骤 4：补充安全边界失败测试并先观察失败**

精简覆盖：

- AccessKey `code !== 200` 或缺字段；
- 上传凭证 URL 为 HTTP、其他主机、非 `/` 路径、查询参数或重定向；
- 七牛 `errno !== 0`、MIME 错误、大小不符、最终 URL 为其他主机；
- 输入非 PNG 或大于 2 MiB 时零次 fetch；
- JSON 流超过 64 KiB；
- 上游响应含 `token-secret-marker` 时，抛出的错误和 `console` 调用中均不包含该标记。

- [ ] **步骤 5：完成验证逻辑并运行图片客户端测试**

```powershell
npx vitest run test/pushplus-image.test.ts
```

预期：全部通过，无凭据出现在输出。

- [ ] **步骤 6：以测试先行扩展配置**

先在 `test/config-source.test.ts` 的合法环境增加 32 字符以上测试值，再增加：

```ts
expect(loadConfig({
  ...validEnv,
  PUSHPLUS_SECRET_KEY: undefined
} as unknown as Cloudflare.Env).pushplus.secretKey).toBeUndefined();

expect(() => loadConfig({
  ...validEnv,
  PUSHPLUS_SECRET_KEY: "short"
} as unknown as Cloudflare.Env)).toThrow("at least 32 characters");
```

确认失败后，在 `AppConfig["pushplus"]` 增加 `secretKey?: string`。未配置时允许应用启动，让图片阶段安全降级为文字；一旦配置则必须至少 32 字符。生产仍把它列入 Wrangler 必需 Secret，避免正式环境长期静默降级。

同步更新：

- `vitest.config.ts` 测试 binding：`PUSHPLUS_SECRET_KEY: "test-pushplus-secret-key-32-bytes-minimum"`；
- `.dev.vars.example`：只放测试占位值；
- `wrangler.jsonc` 的 `secrets.required` 增加 `PUSHPLUS_SECRET_KEY`；
- 运行 `npm run typegen` 更新 `worker-configuration.d.ts`。

- [ ] **步骤 7：运行任务 2 测试与类型检查**

```powershell
npx vitest run test/pushplus-image.test.ts test/config-source.test.ts
npm run typecheck
```

预期：全部通过。

- [ ] **步骤 8：提交任务 2**

```powershell
git add src/pushplus-image.ts test/pushplus-image.test.ts src/config.ts test/config-source.test.ts vitest.config.ts .dev.vars.example wrangler.jsonc worker-configuration.d.ts
git commit -m "功能：上传图表到 PushPlus 官方图片服务"
```

---

### Task 3：接入广播创建、文字降级与幂等

**文件：**

- 修改：`src/app.ts`
- 修改：`test/app.test.ts`

**接口：**

在 `src/app.ts` 增加：

```ts
export type UsageChartImagePublisher = (
  aggregate: UsageAggregate,
  eventId: string
) => Promise<string>;

export interface AppDeps {
  // 保留现有字段
  chartImagePublisher?: UsageChartImagePublisher;
}
```

默认实现先检查可选 `config.pushplus.secretKey`；未配置时在图片 try 内抛出安全的 `PushPlusImageError("access_key", "invalid")`，不调用 Browser Run。已配置时依次调用任务 1 的 `renderUsageChartPng(env.BROWSER, aggregate)` 和任务 2 的 `uploadPushPlusPng({ token: config.pushplus.token, secretKey }, bytes)`，只记录事件编号、阶段、`browserMs` 和是否降级。

- [ ] **步骤 1：改写成功路径测试并确认旧实现失败**

将现有“定时额度与明细成功时原子保存同编号事件和图表快照”改为：注入返回固定 `pic.pushplus.plus` URL 的 `chartImagePublisher`，断言：

```ts
expect(event?.content).toContain(
  "https://pic.pushplus.plus/1/usage-chart.png@p"
);
expect(event?.content).toContain("<img");
expect(await env.DB.prepare(
  "SELECT COUNT(*) AS count FROM usage_chart_snapshots"
).first()).toEqual({ count: 0 });
```

同一测试仍断言文字总 Token、模型排行和消息成功状态。运行该单测，预期旧实现因仍写 SVG URL 与快照而失败。

- [ ] **步骤 2：实现最小成功接入**

在 `src/app.ts:659-740`：

1. 保留先创建 `textOnlyEvent` 的顺序，使用其确定性 `id`。
2. `usageView.status === "available"` 时调用 `chartImagePublisher(usageView.aggregate, textOnlyEvent.id)`。
3. 验证返回 URL 为 HTTPS 且 hostname 精确为 `pic.pushplus.plus`；成功后用相同逻辑键重新渲染富消息。
4. 图片阶段 catch 后回到 `textOnlyEvent`，记录不含异常消息的结构化警告。
5. 所有提交固定 `usageChartSnapshots: []`；删除只服务旧 SVG 快照事务回退的第二次 commit 分支。
6. 图片上传成功但 D1 commit 失败时保留原异常，不再提交文字替代事件；孤儿图片由 PushPlus 30 天后清理。

默认发布函数：

```ts
const chartImagePublisher = deps.chartImagePublisher ?? (async (
  aggregate,
  eventId
) => {
  const secretKey = config.pushplus.secretKey;
  if (secretKey === undefined) {
    throw new PushPlusImageError("access_key", "invalid");
  }
  const rendered = await renderUsageChartPng(env.BROWSER, aggregate);
  console.log(JSON.stringify({
    event: "usage_chart_png_rendered",
    eventId,
    browserMs: rendered.browserMs
  }));
  return await uploadPushPlusPng({
    token: config.pushplus.token,
    secretKey
  }, rendered.bytes);
});
```

- [ ] **步骤 3：运行成功路径单测并确认通过**

```powershell
npx vitest run test/app.test.ts -t "定时额度与明细成功时使用 PushPlus PNG"
```

预期：通过。

- [ ] **步骤 4：先写降级和幂等失败测试**

精简保留三条行为：

1. `chartImagePublisher` 抛出含敏感标记的异常时，广播仍为 `completed`，outbox 只有一条完整文字消息，含“图表暂不可用”、无 `<img>`、无敏感标记、无新快照。
2. 同一手动幂等键调用两次时返回 `completed`、`duplicate`，图片发布函数只执行一次，PushPlus 消息也只投递一次。
3. 图片发布成功后将 `Repository.prototype.commitSnapshotUnderLease` 模拟为 `LeaseLostError`，断言不进行第二次文字 commit、不调用消息投递，并继续抛出租约异常。

运行这三条测试，确认旧实现或步骤 2 的未完整实现出现预期失败。

- [ ] **步骤 5：完成降级、租约与幂等实现**

实现固定错误日志：

```ts
const stage = error instanceof UsageChartPngError
  ? "png"
  : error instanceof PushPlusImageError
    ? error.stage
    : "publish";
console.warn(JSON.stringify({
  event: "usage_chart_image_fallback",
  eventId: textOnlyEvent.id,
  stage
}));
```

不得记录 catch 到的异常对象或消息。确保 `tryStartJob` 的重复判断发生在图片发布之前，outbox commit 发生在图片发布之后，`dispatchDue` 仍发生在 commit 之后。

- [ ] **步骤 6：更新现有图表相关应用测试**

对 `test/app.test.ts` 中依赖新图片的用例注入成功发布函数，并做以下机械调整：

- 手动广播测试改断言 `pic.pushplus.plus` 且快照数为 0；
- 合法空明细仍生成零值 PNG 消息，不再从快照表读取图表 JSON；直接在发布函数接收的 aggregate 上断言 24 个零值桶；
- 删除旧“图表快照事务失败后二次提交文字”测试，替换为图片发布失败一次提交文字；
- 历史快照清理测试、仓储快照原子测试、`test/usage-chart.test.ts` 全部保留。

- [ ] **步骤 7：运行应用和旧图表回归测试**

```powershell
npx vitest run test/app.test.ts test/rules.test.ts test/usage-chart.test.ts test/repository.test.ts
```

预期：全部通过；旧 SVG 路由仍可用，新广播不再写快照。

- [ ] **步骤 8：提交任务 3**

```powershell
git add src/app.ts test/app.test.ts
git commit -m "功能：在广播中使用 PushPlus PNG 图表"
```

---

### Task 4：文档、全量验证与远程冒烟准备

**文件：**

- 修改：`README.md`
- 已存在：`docs/superpowers/specs/2026-08-08-pushplus-png-chart-design.md`

**接口：** 无新运行时接口；本任务交付可执行的中文配置与验证说明。

- [ ] **步骤 1：更新中文运维说明**

在 `README.md` 增加“PushPlus PNG 图表”小节，明确：

1. 图片服务当前为收费能力，会员限时免费；账号必须具备上传权限。
2. 在 PushPlus 开发设置开启开放接口，设置至少 32 位随机 SecretKey，并关闭 IP 白名单；普通 Worker 无固定出口 IP。
3. 用交互式 `npx wrangler secret put PUSHPLUS_SECRET_KEY` 设置相同密钥，不能把值写入命令参数、仓库或日志。
4. Browser Run 本地纯 local 不支持 Quick Action；真实验证使用远程预览或部署版本。
5. 图片失败自动发送完整文字，历史 SVG 最多继续保留 30 天。

同步把 README 中生产 Secret 名称清单增加 `PUSHPLUS_SECRET_KEY`。

- [ ] **步骤 2：运行格式与静态验证**

```powershell
git diff --check
npm run typecheck
npx wrangler deploy --dry-run
```

预期：无空白错误、类型通过、Wrangler dry-run 成功并识别 `BROWSER` binding。

- [ ] **步骤 3：运行全量测试**

```powershell
npm test
npm run test:auth
```

预期：全部通过，输出无未处理异常和敏感数据。

- [ ] **步骤 4：检查变更范围与敏感信息**

```powershell
git status --short
git diff --stat master...HEAD
rg -n "PUSHPLUS_SECRET_KEY|accessKey|uploadToken" src test README.md .dev.vars.example wrangler.jsonc
```

逐项确认只出现变量名、测试占位值和固定字段名，没有真实 Token、SecretKey、AccessKey 或上传 Token。

- [ ] **步骤 5：提交任务 4**

```powershell
git add README.md
git commit -m "文档：补充 PushPlus PNG 图表配置说明"
```

- [ ] **步骤 6：代码审查后推送中文 PR**

最终审查通过后推送 `codex/pushplus-png-image`，创建非草稿 PR：

- 标题：`修复 PushPlus 用量图表偶发无法显示`
- 正文全部中文，说明 PNG 官方图床、文字降级、安全取舍、测试结果和上线前账号配置。

- [ ] **步骤 7：合并后生产配置与真实冒烟**

仅在用户合并 PR 后执行：

1. 在 PushPlus 已登录后台确认图片权限，开启开放接口、配置随机 SecretKey、关闭 IP 白名单。
2. 以交互式 Wrangler 命令写入同一 `PUSHPLUS_SECRET_KEY`。
3. 部署 Worker，手动触发一次广播。
4. 确认消息正文完整，图片 URL 主机为 `pic.pushplus.plus`，微信 PushPlus 详情页可显示 PNG。
5. 查看脱敏日志确认 `browserMs` 合理且没有文字降级；再观察下一次整点广播。

如果账号无图片权限、AccessKey 403 或 Browser Run 不可用，保留已部署的文字降级能力，不反复触发；先修复账户配置再重新冒烟。
