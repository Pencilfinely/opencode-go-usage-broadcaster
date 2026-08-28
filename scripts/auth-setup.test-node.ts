import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  cleanUpBrowserProfile,
  uploadSessionBundle,
  type UploadChild
} from "./auth-setup";

type FakeUsageResponse = ReturnType<typeof makeUsageResponse>;

function makeUsageResponse(options: {
  url: string;
  method?: string;
  requestBody?: string;
  headers?: Record<string, string>;
  onReadRequestBody?: () => void;
}): {
  ok(): boolean;
  url(): string;
  request(): {
    url(): string;
    method(): string;
    headers(): Record<string, string>;
    postData(): string | null;
  };
  body(): Promise<Buffer>;
  headers(): Record<string, string>;
} {
  const method = options.method ?? "GET";
  return {
    ok: () => true,
    url: () => options.url,
    request: () => ({
      url: () => options.url,
      method: () => method,
      headers: () => options.headers ?? ({
        accept: "text/javascript",
        "content-type": "application/json",
        "x-server-id": serverFunctionId,
        "x-server-instance": "server-fn:0"
      }),
      postData: () => {
        options.onReadRequestBody?.();
        return options.requestBody ?? null;
      }
    }),
    body: async () => Buffer.from("[]", "utf8"),
    headers: () => ({ "content-type": "application/json" })
  };
}

function pageWithResponses(responses: FakeUsageResponse[]): {
  waitForResponse(
    predicate: (response: FakeUsageResponse) => boolean | Promise<boolean>
  ): Promise<FakeUsageResponse>;
} {
  return {
    async waitForResponse(predicate) {
      for (const response of responses) {
        if (await predicate(response)) return response;
      }
      throw new Error("没有响应通过捕获谓词");
    }
  };
}

const serovalUsageArgs = (workspaceId: string, page: number) => JSON.stringify({
  t: {
    t: 9,
    i: 0,
    l: 2,
    a: [{ t: 1, s: workspaceId }, { t: 0, s: page }],
    o: 0
  },
  f: 31,
  m: []
});

const serverFunctionId = "a".repeat(64);

function usageGetUrl(workspaceId: string, page: number, id = serverFunctionId): string {
  const search = new URLSearchParams({
    id,
    args: serovalUsageArgs(workspaceId, page)
  });
  return `https://opencode.ai/_server?${search.toString()}`;
}

test("触发失败时取消内部 waiter 并回收其拒绝后重抛原始错误", async () => {
  const module = await import("./opencode-usage-capture");
  const waitBeforeTrigger = (module as Record<string, unknown>)
    .waitBeforeTrigger as ((
      externalSignal: AbortSignal,
      startWaiter: (signal: AbortSignal) => Promise<unknown>,
      trigger: (signal: AbortSignal) => Promise<void>
    ) => Promise<unknown>) | undefined;
  if (!waitBeforeTrigger) throw new Error("缺少等待触发协作器");
  const triggerError = new Error("触发动作失败");
  let receivedSignal: AbortSignal | undefined;
  let waiterSettled = false;

  await assert.rejects(
    waitBeforeTrigger?.(
      new AbortController().signal,
      (signal) => new Promise((_, reject) => {
        receivedSignal = signal;
        signal.addEventListener("abort", () => {
          queueMicrotask(() => {
            waiterSettled = true;
            reject(new Error("waiter 已取消"));
          });
        }, { once: true });
      }),
      async () => { throw triggerError; }
    ),
    (error: unknown) => error === triggerError
  );

  assert.equal(receivedSignal?.aborted, true);
  assert.equal(waiterSettled, true);
});

test("只保留捕获请求的必要头", async () => {
  const module = await import("./opencode-usage-capture");
  const minimizeCapturedRequest = (module as Record<string, unknown>)
    .minimizeCapturedRequest as ((request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => unknown) | undefined;

  assert.deepEqual(minimizeCapturedRequest?.({
    url: usageGetUrl("wrk_abc", 0),
    method: "GET",
    headers: {
      accept: "text/javascript",
      "content-type": "application/json",
      "x-server-id": serverFunctionId,
      "x-server-instance": "server-fn:0",
      cookie: "不得进入结果",
      origin: "https://opencode.ai",
      "x-test": "不得进入结果"
    },
  }), {
    url: usageGetUrl("wrk_abc", 0),
    method: "GET",
    headers: {
      accept: "text/javascript"
    }
  });
});

test("按工作区和期望页识别真实 GET usage 请求，并跳过错误页和错误函数 ID", async () => {
  const module = await import("./opencode-usage-capture");
  const waitForUsageListPage = (module as Record<string, unknown>)
    .waitForUsageListPage as ((
      page: unknown,
      workspaceId: string,
      expectedPage: number,
      signal: AbortSignal
    ) => Promise<{ request: { url: string; method: string; body?: string } }>) | undefined;
  if (!waitForUsageListPage) throw new Error("缺少 usage 页面捕获器");
  const wrongPage = makeUsageResponse({
    url: usageGetUrl("wrk_Target9", 1)
  });
  const mismatchedId = makeUsageResponse({
    url: usageGetUrl("wrk_Target9", 0),
    headers: {
      "x-server-id": "b".repeat(64),
      "x-server-instance": "server-fn:0"
    }
  });
  const semanticId = makeUsageResponse({
    url: usageGetUrl("wrk_Target9", 0, "usage.list"),
    headers: {
      "x-server-id": "usage.list",
      "x-server-instance": "server-fn:0"
    }
  });
  const malformedInstance = makeUsageResponse({
    url: usageGetUrl("wrk_Target9", 0),
    headers: {
      "x-server-id": serverFunctionId,
      "x-server-instance": "server-fn:-1"
    }
  });
  const expectedPage = makeUsageResponse({
    url: usageGetUrl("wrk_Target9", 0)
  });

  const captured = await waitForUsageListPage(
    pageWithResponses([wrongPage, mismatchedId, semanticId, malformedInstance, expectedPage]),
    "wrk_Target9",
    0,
    new AbortController().signal
  );

  assert.equal(captured.request.url, usageGetUrl("wrk_Target9", 0));
  assert.equal(captured.request.method, "GET");
  assert.equal(captured.request.body, undefined);
});

test("粗筛选同源无关请求时不读取请求体", async () => {
  const module = await import("./opencode-usage-capture");
  const waitForUsageListPage = (module as Record<string, unknown>)
    .waitForUsageListPage as ((
      page: unknown,
      workspaceId: string,
      expectedPage: number,
      signal: AbortSignal
    ) => Promise<unknown>) | undefined;
  if (!waitForUsageListPage) throw new Error("缺少 usage 页面捕获器");
  let unrelatedBodyReads = 0;
  const unrelated = makeUsageResponse({
    url: "https://opencode.ai/api/upload",
    onReadRequestBody: () => {
      unrelatedBodyReads += 1;
      throw new Error("无关请求体不得读取");
    }
  });
  const expectedPage = makeUsageResponse({
    url: usageGetUrl("wrk_Target9", 0)
  });

  await waitForUsageListPage(
    pageWithResponses([unrelated, expectedPage]),
    "wrk_Target9",
    0,
    new AbortController().signal
  );

  assert.equal(unrelatedBodyReads, 0);
});

test("从第 0 页 GET 请求派生可回放的第 1 页授权", async () => {
  const capture = await import("./opencode-usage-capture");
  const session = await import("../src/opencode-session");
  const buildUsageGetAuthorization = (capture as Record<string, unknown>)
    .buildUsageGetAuthorization as ((
      firstPage: { url: string; method: string; headers: Record<string, string> },
      workspaceId: string,
      recordCount: number
    ) => unknown) | undefined;
  if (!buildUsageGetAuthorization) throw new Error("缺少 GET usage 授权构建器");
  const firstPage = {
    url: usageGetUrl("wrk_Target9", 0),
    method: "GET",
    headers: { accept: "text/javascript" }
  };

  const authorization = buildUsageGetAuthorization(firstPage, "wrk_Target9", 50) as {
    firstPage: typeof firstPage;
    pagination: { mode: string; template?: unknown };
  };
  assert.equal(authorization.pagination.mode, "paginated");
  if (!authorization.pagination.template) throw new Error("缺少分页模板");
  assert.deepEqual(
    session.renderUsagePageRequest(authorization.firstPage, authorization.pagination.template as never, 0),
    authorization.firstPage
  );
  assert.doesNotThrow(() => session.validateUsageListRequestDescriptor(
    session.renderUsagePageRequest(authorization.firstPage, authorization.pagination.template as never, 1),
    "wrk_Target9",
    1
  ));
});

test("第 0 页记录数决定单页或分页授权，并拒绝范围外数量", async () => {
  const capture = await import("./opencode-usage-capture");
  const buildUsageGetAuthorization = (capture as Record<string, unknown>)
    .buildUsageGetAuthorization as ((
      firstPage: { url: string; method: string; headers: Record<string, string> },
      workspaceId: string,
      recordCount: number
    ) => { pagination: { mode: string } }) | undefined;
  if (!buildUsageGetAuthorization) throw new Error("缺少 GET usage 授权构建器");
  const firstPage = {
    url: usageGetUrl("wrk_Target9", 0),
    method: "GET",
    headers: {}
  };

  assert.equal(buildUsageGetAuthorization(firstPage, "wrk_Target9", 49).pagination.mode, "single-page");
  assert.equal(buildUsageGetAuthorization(firstPage, "wrk_Target9", 50).pagination.mode, "paginated");
  assert.throws(() => buildUsageGetAuthorization(firstPage, "wrk_Target9", -1));
  assert.throws(() => buildUsageGetAuthorization(firstPage, "wrk_Target9", 51));
});

test("严格验证仅接受精确的 SolidStart GET 请求图", async () => {
  const session = await import("../src/opencode-session");
  const firstPage = {
    url: usageGetUrl("wrk_Target9", 0),
    method: "GET",
    headers: {}
  };
  assert.doesNotThrow(() => session.validateUsageListRequestDescriptor(firstPage, "wrk_Target9", 0));
  for (const invalid of [
    { ...firstPage, method: "POST" },
    { ...firstPage, body: "forbidden" },
    { ...firstPage, url: usageGetUrl("wrk_Target9", 0, "usage.list") },
    { ...firstPage, url: `${firstPage.url}&extra=value` },
    { ...firstPage, url: `${firstPage.url}#fragment` }
  ]) {
    assert.throws(() => session.validateUsageListRequestDescriptor(invalid, "wrk_Target9", 0));
  }
});

test("页号模板拒绝 URL 的固定部分变化", async () => {
  const module = await import("./opencode-usage-capture");
  const deriveUsagePageNumberTemplate = (module as Record<string, unknown>)
    .deriveUsagePageNumberTemplate as ((
      zero: { url: string; method: string; headers: Record<string, string>; body?: string },
      one: { url: string; method: string; headers: Record<string, string>; body?: string }
    ) => unknown) | undefined;

  assert.throws(() => deriveUsagePageNumberTemplate?.(
    {
      url: "https://opencode.ai/_server?id=usage.list&source=console",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["wrk_abc",0]'
    },
    {
      url: "https://opencode.ai/_server?id=usage.list&source=web",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["wrk_abc",1]'
    }
  ));
});

test("页号模板拒绝请求头变化", async () => {
  const module = await import("./opencode-usage-capture");
  const deriveUsagePageNumberTemplate = (module as Record<string, unknown>)
    .deriveUsagePageNumberTemplate as ((
      zero: { url: string; method: string; headers: Record<string, string>; body?: string },
      one: { url: string; method: string; headers: Record<string, string>; body?: string }
    ) => unknown) | undefined;

  assert.throws(() => deriveUsagePageNumberTemplate?.(
    {
      url: "https://opencode.ai/_server?id=usage.list",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["wrk_abc",0]'
    },
    {
      url: "https://opencode.ai/_server?id=usage.list",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '["wrk_abc",1]'
    }
  ));
});

test("版本级模式使用 versions secret put", async () => {
  const module = await import("./auth-setup");
  const buildWranglerSecretArgs = (module as Record<string, unknown>)
    .buildWranglerSecretArgs as ((cli: string, mode: string) => string[]) | undefined;

  assert.deepEqual(buildWranglerSecretArgs?.("wrangler.js", "version-only"), [
    "wrangler.js", "versions", "secret", "put", "OPENCODE_SESSION_BUNDLE"
  ]);
});

test("仅接受可选的版本级上传参数", async () => {
  const module = await import("./auth-setup");
  const parseAuthSetupArgs = (module as Record<string, unknown>)
    .parseAuthSetupArgs as ((argv: readonly string[]) => unknown) | undefined;

  assert.deepEqual(parseAuthSetupArgs?.([]), { uploadMode: "deployed" });
  assert.deepEqual(parseAuthSetupArgs?.(["--version-only"]), { uploadMode: "version-only" });
  assert.throws(() => parseAuthSetupArgs?.(["--bad"]));
});

test("解析复用浏览器资料、工作区和版本级上传参数", async () => {
  const module = await import("./auth-setup");
  const parseAuthSetupArgs = (module as Record<string, unknown>)
    .parseAuthSetupArgs as ((argv: readonly string[]) => unknown) | undefined;

  assert.deepEqual(
    parseAuthSetupArgs?.([
      "--profile",
      "C:\\OpenCode授权资料",
      "--workspace",
      "wrk_Target9",
      "--version-only"
    ]),
    {
      uploadMode: "version-only",
      profileDirectory: "C:\\OpenCode授权资料",
      workspaceId: "wrk_Target9"
    }
  );
  assert.throws(() => parseAuthSetupArgs?.(["--profile"]));
  assert.throws(() => parseAuthSetupArgs?.(["--workspace", "not-safe"]));
  assert.throws(
    () => parseAuthSetupArgs?.(["--workspace", "wrk_Target9"]),
    /--profile/u
  );
  assert.throws(() => parseAuthSetupArgs?.(["--version-only", "--version-only"]));
});

test("从目标工作区页及其子页识别受限的工作区 ID", async () => {
  const module = await import("./auth-setup");
  const workspaceIdFromPageUrl = (module as Record<string, unknown>)
    .workspaceIdFromPageUrl as ((url: string) => string | undefined) | undefined;

  assert.equal(
    workspaceIdFromPageUrl?.("https://opencode.ai/workspace/wrk_Alpha42"),
    "wrk_Alpha42"
  );
  assert.equal(
    workspaceIdFromPageUrl?.("https://opencode.ai/workspace/wrk_Alpha42/settings"),
    "wrk_Alpha42"
  );
  assert.equal(workspaceIdFromPageUrl?.("https://evil.example/workspace/wrk_Alpha42"), undefined);
  assert.equal(workspaceIdFromPageUrl?.("https://opencode.ai/workspace/not-safe"), undefined);
});

test("为工作区生成官方 usage 页面地址", async () => {
  const module = await import("./auth-setup");
  const workspaceUsageUrl = (module as Record<string, unknown>)
    .workspaceUsageUrl as ((workspaceId: string) => string) | undefined;

  assert.equal(
    workspaceUsageUrl?.("wrk_Target9"),
    "https://opencode.ai/workspace/wrk_Target9/usage"
  );
});

test("通过同源 SPA 锚点导航 usage 页面且不使用完整文档跳转", async () => {
  const module = await import("./auth-setup");
  const navigateWithinOpenCodeApp = (module as Record<string, unknown>)
    .navigateWithinOpenCodeApp as ((
      page: unknown,
      targetUrl: string,
      signal: AbortSignal
    ) => Promise<void>) | undefined;
  if (!navigateWithinOpenCodeApp) throw new Error("缺少 SPA 导航辅助函数");

  const actions: string[] = [];
  let createdTag = "";
  let anchorHref = "";
  const anchorAttributes = new Map<string, string>();
  const anchor = {
    hidden: false,
    set href(value: string) { anchorHref = value; },
    setAttribute(name: string, value: string) {
      anchorAttributes.set(name, value);
    },
    click() { actions.push("点击"); },
    remove() { actions.push("移除"); }
  };
  const fakeDocument = {
    createElement(tag: string) {
      createdTag = tag;
      return anchor;
    },
    body: {
      append(element: unknown) {
        assert.equal(element, anchor);
        actions.push("追加");
      }
    }
  };
  let gotoCalls = 0;
  const fakePage = {
    async evaluate(callback: (href: string) => void, href: string) {
      const globals = globalThis as { document?: unknown };
      const originalDocument = globals.document;
      globals.document = fakeDocument;
      try {
        callback(href);
      } finally {
        globals.document = originalDocument;
      }
    },
    async goto() {
      gotoCalls += 1;
      throw new Error("usage 导航不得调用 goto");
    }
  };

  await navigateWithinOpenCodeApp(
    fakePage,
    "https://opencode.ai/workspace/wrk_Target9/usage",
    new AbortController().signal
  );

  assert.equal(createdTag, "a");
  assert.equal(anchorHref, "https://opencode.ai/workspace/wrk_Target9/usage");
  assert.equal(anchor.hidden, true);
  assert.equal(anchorAttributes.get("link"), "");
  assert.deepEqual(actions, ["追加", "点击", "移除"]);
  assert.equal(gotoCalls, 0);
});

test("在执行页面代码前拒绝无效或非 usage 的 SPA 导航目标", async () => {
  const module = await import("./auth-setup");
  const navigateWithinOpenCodeApp = (module as Record<string, unknown>)
    .navigateWithinOpenCodeApp as ((
      page: unknown,
      targetUrl: string,
      signal: AbortSignal
    ) => Promise<void>) | undefined;
  if (!navigateWithinOpenCodeApp) throw new Error("缺少 SPA 导航辅助函数");

  let evaluateCalls = 0;
  const fakePage = {
    async evaluate() { evaluateCalls += 1; }
  };

  for (const targetUrl of [
    "not a URL",
    "https://evil.example/workspace/wrk_Target9/usage",
    "https://opencode.ai/workspace/wrk_Target9/go",
    "https://opencode.ai/workspace/wrk_Target9/usage?from=test",
    "https://opencode.ai/workspace/wrk_Target9/usage#details"
  ]) {
    await assert.rejects(
      navigateWithinOpenCodeApp(fakePage, targetUrl, new AbortController().signal),
      /SPA 导航目标/u
    );
  }
  assert.equal(evaluateCalls, 0);
});

test("SPA 导航预先取消时不执行页面代码", async () => {
  const module = await import("./auth-setup");
  const navigateWithinOpenCodeApp = (module as Record<string, unknown>)
    .navigateWithinOpenCodeApp as ((
      page: unknown,
      targetUrl: string,
      signal: AbortSignal
    ) => Promise<void>) | undefined;
  if (!navigateWithinOpenCodeApp) throw new Error("缺少 SPA 导航辅助函数");

  const controller = new AbortController();
  controller.abort(new Error("用户取消 SPA 导航"));
  let evaluateCalls = 0;

  await assert.rejects(
    navigateWithinOpenCodeApp(
      { async evaluate() { evaluateCalls += 1; } },
      "https://opencode.ai/workspace/wrk_Target9/usage",
      controller.signal
    ),
    /用户取消 SPA 导航/u
  );
  assert.equal(evaluateCalls, 0);
});

test("轮询当前及上下文页面直到识别目标工作区", async () => {
  const module = await import("./auth-setup");
  const waitForWorkspaceId = (module as Record<string, unknown>)
    .waitForWorkspaceId as (
      context: { pages(): Array<{ url(): string }> },
      signal: AbortSignal,
      pause: (signal: AbortSignal) => Promise<void>
    ) => Promise<string>;
  const urls = ["https://opencode.ai/auth"];
  let pauses = 0;

  const workspaceId = await waitForWorkspaceId(
    { pages: () => urls.map((url) => ({ url: () => url })) },
    new AbortController().signal,
    async () => {
      pauses += 1;
      urls.push("https://opencode.ai/workspace/wrk_Target9/preferences");
    }
  );

  assert.equal(workspaceId, "wrk_Target9");
  assert.equal(pauses, 1);
});

test("复用资料时优先使用显式工作区，否则仅从已有页面识别", async () => {
  const module = await import("./auth-setup");
  const resolveProfileWorkspaceId = (module as Record<string, unknown>)
    .resolveProfileWorkspaceId as ((
      context: { pages(): Array<{ url(): string }> },
      requested?: string
    ) => string) | undefined;

  assert.equal(typeof resolveProfileWorkspaceId, "function");
  if (!resolveProfileWorkspaceId) return;
  const context = {
    pages: () => [{ url: () => "https://opencode.ai/workspace/wrk_Saved/go" }]
  };
  assert.equal(resolveProfileWorkspaceId(context, "wrk_Explicit"), "wrk_Explicit");
  assert.equal(resolveProfileWorkspaceId(context), "wrk_Saved");
  assert.throws(
    () => resolveProfileWorkspaceId({ pages: () => [] }),
    /--workspace/u
  );
  assert.throws(
    () => resolveProfileWorkspaceId({
      pages: () => [
        { url: () => "https://opencode.ai/workspace/wrk_First/go" },
        { url: () => "https://opencode.ai/workspace/wrk_Second/usage" }
      ]
    }),
    /--workspace/u
  );
});

test("登录页只等待文档提交，不限制用户完成登录的时间", async () => {
  const module = await import("./auth-setup");
  const openAuthenticationPage = (module as Record<string, unknown>)
    .openAuthenticationPage as ((
      context: { newPage(): Promise<unknown> },
      signal: AbortSignal
    ) => Promise<unknown>) | undefined;

  assert.equal(typeof openAuthenticationPage, "function");
  if (!openAuthenticationPage) return;
  const actions: string[] = [];
  const controller = new AbortController();
  const page = {
    async goto(url: string, options: Record<string, unknown>) {
      actions.push("打开登录页");
      assert.equal(url, "https://opencode.ai/auth");
      assert.equal(options.waitUntil, "commit");
      assert.equal(options.timeout, 15_000);
      assert.equal(options.signal, controller.signal);
    }
  };

  const opened = await openAuthenticationPage(
    {
      async newPage() {
        actions.push("新建页面");
        return page;
      }
    },
    controller.signal
  );

  assert.equal(opened, page);
  assert.deepEqual(actions, ["新建页面", "打开登录页"]);
});

test("复用浏览器资料时先校验登录 Cookie，再识别工作区", async () => {
  const module = await import("./auth-setup");
  const resolveReusableProfile = (module as Record<string, unknown>)
    .resolveReusableProfile as ((
      context: {
        cookies(url: string): Promise<Array<{ name: string; value: string }>>;
        pages(): Array<{ url(): string }>;
      },
      requested?: string
    ) => Promise<{ workspaceId: string; authCookieValue: string }>) | undefined;

  assert.equal(typeof resolveReusableProfile, "function");
  if (!resolveReusableProfile) return;
  let pagesRead = 0;
  await assert.rejects(
    resolveReusableProfile({
      async cookies(url) {
        assert.equal(url, "https://opencode.ai");
        return [];
      },
      pages() {
        pagesRead += 1;
        return [{ url: () => "https://opencode.ai/workspace/wrk_Saved/go" }];
      }
    }),
    /auth Cookie/u
  );
  assert.equal(pagesRead, 0);

  const resolved = await resolveReusableProfile({
    async cookies() {
      return [{ name: "auth", value: "cookie-value" }];
    },
    pages() {
      return [{ url: () => "https://opencode.ai/workspace/wrk_Saved/go" }];
    }
  });
  assert.deepEqual(resolved, {
    workspaceId: "wrk_Saved",
    authCookieValue: "cookie-value"
  });
});

test("复用登录资料但没有工作区标签页时自动恢复工作区", async () => {
  const module = await import("./auth-setup");
  const preparePersistentProfileAuthorization = (module as Record<string, unknown>)
    .preparePersistentProfileAuthorization as ((
      context: {
        cookies(url: string): Promise<Array<{ name: string; value: string }>>;
        pages(): Array<{ url(): string }>;
        newPage(): Promise<unknown>;
      },
      requestedWorkspaceId: string | undefined,
      signal: AbortSignal,
      onLoginRequired: () => void
    ) => Promise<{
      workspaceId: string;
      authCookieValue: string;
      reusedExistingSession: boolean;
    }>) | undefined;

  assert.equal(typeof preparePersistentProfileAuthorization, "function");
  if (!preparePersistentProfileAuthorization) return;
  const urls = ["about:blank"];
  const controller = new AbortController();
  let loginPrompts = 0;
  let openedPages = 0;
  let cookieChecks = 0;

  const prepared = await preparePersistentProfileAuthorization(
    {
      async cookies(url) {
        assert.equal(url, "https://opencode.ai");
        cookieChecks += 1;
        return [{
          name: "auth",
          value: cookieChecks === 1 ? "saved-cookie" : "renewed-cookie"
        }];
      },
      pages() {
        return urls.map((url) => ({ url: () => url }));
      },
      async newPage() {
        openedPages += 1;
        return {
          async goto(url: string, options: Record<string, unknown>) {
            assert.equal(url, "https://opencode.ai/auth");
            assert.equal(options.waitUntil, "commit");
            assert.equal(options.signal, controller.signal);
            urls.push("https://opencode.ai/workspace/wrk_Recovered/usage");
          }
        };
      }
    },
    undefined,
    controller.signal,
    () => { loginPrompts += 1; }
  );

  assert.deepEqual(prepared, {
    workspaceId: "wrk_Recovered",
    authCookieValue: "renewed-cookie",
    reusedExistingSession: true
  });
  assert.equal(openedPages, 1);
  assert.equal(loginPrompts, 1);
  assert.equal(cookieChecks, 2);
});

test("全新持久资料会完成首次登录并保留可复用状态", async () => {
  const module = await import("./auth-setup");
  const preparePersistentProfileAuthorization = (module as Record<string, unknown>)
    .preparePersistentProfileAuthorization as ((
      context: {
        cookies(url: string): Promise<Array<{ name: string; value: string }>>;
        pages(): Array<{ url(): string }>;
        newPage(): Promise<unknown>;
      },
      requestedWorkspaceId: string | undefined,
      signal: AbortSignal,
      onLoginRequired: () => void
    ) => Promise<{
      workspaceId: string;
      authCookieValue: string;
      reusedExistingSession: boolean;
    }>) | undefined;

  assert.equal(typeof preparePersistentProfileAuthorization, "function");
  if (!preparePersistentProfileAuthorization) return;
  const actions: string[] = [];
  let loggedIn = false;
  const controller = new AbortController();
  const page = {
    async goto(url: string, options: Record<string, unknown>) {
      actions.push("打开登录页");
      assert.equal(url, "https://opencode.ai/auth");
      assert.equal(options.waitUntil, "commit");
      assert.equal(options.signal, controller.signal);
      loggedIn = true;
    }
  };

  const prepared = await preparePersistentProfileAuthorization(
    {
      async cookies(url) {
        actions.push("检查 Cookie");
        assert.equal(url, "https://opencode.ai");
        return loggedIn ? [{ name: "auth", value: "saved-cookie" }] : [];
      },
      pages() {
        actions.push("识别工作区");
        return loggedIn
          ? [{ url: () => "https://opencode.ai/workspace/wrk_Saved/go" }]
          : [];
      },
      async newPage() {
        actions.push("新建页面");
        return page;
      }
    },
    undefined,
    controller.signal,
    () => { actions.push("提示首次登录"); }
  );

  assert.deepEqual(prepared, {
    workspaceId: "wrk_Saved",
    authCookieValue: "saved-cookie",
    reusedExistingSession: false
  });
  assert.deepEqual(actions, [
    "检查 Cookie",
    "新建页面",
    "打开登录页",
    "提示首次登录",
    "检查 Cookie",
    "识别工作区",
    "识别工作区",
  ]);
});

test("持久资料 Cookie 失效时不把旧工作区标签页误判为登录完成", async () => {
  const module = await import("./auth-setup");
  const preparePersistentProfileAuthorization = (module as Record<string, unknown>)
    .preparePersistentProfileAuthorization as ((
      context: {
        cookies(url: string): Promise<Array<{ name: string; value: string }>>;
        pages(): Array<{ url(): string }>;
        newPage(): Promise<unknown>;
      },
      requestedWorkspaceId: string | undefined,
      signal: AbortSignal,
      onLoginRequired: () => void
    ) => Promise<{ workspaceId: string; authCookieValue: string }>) | undefined;

  assert.equal(typeof preparePersistentProfileAuthorization, "function");
  if (!preparePersistentProfileAuthorization) return;
  let cookieChecks = 0;
  const prepared = await preparePersistentProfileAuthorization(
    {
      async cookies() {
        cookieChecks += 1;
        return cookieChecks >= 2
          ? [{ name: "auth", value: "renewed-cookie" }]
          : [];
      },
      pages() {
        if (cookieChecks < 2) {
          throw new Error("登录完成前不应读取旧工作区标签页");
        }
        return [{ url: () => "https://opencode.ai/workspace/wrk_Old/go" }];
      },
      async newPage() {
        return { async goto() { return undefined; } };
      }
    },
    undefined,
    new AbortController().signal,
    () => undefined
  );

  assert.deepEqual(prepared, {
    workspaceId: "wrk_Old",
    authCookieValue: "renewed-cookie",
    reusedExistingSession: false
  });
  assert.equal(cookieChecks, 2);
});

test("从新建空白页以 commit 导航触发 go 捕获", async () => {
  const module = await import("./auth-setup");
  const captureGoAuthorization = (module as Record<string, unknown>)
    .captureGoAuthorization as ((
      context: { newPage(): Promise<unknown> },
      workspaceId: string,
      signal: AbortSignal,
      waitForRequest: (
        page: unknown,
        workspaceId: string,
        signal: AbortSignal
      ) => Promise<unknown>
    ) => Promise<{ page: unknown; goRequest: unknown }>) | undefined;

  assert.equal(typeof captureGoAuthorization, "function");
  if (!captureGoAuthorization) return;
  const actions: string[] = [];
  const goRequest = {
    url: "https://opencode.ai/workspace/wrk_Target9/go",
    method: "GET",
    headers: { accept: "text/html" }
  };
  const page = {
    async goto(url: string, options: Record<string, unknown>) {
      actions.push("触发导航");
      assert.equal(url, goRequest.url);
      assert.equal(options.waitUntil, "commit");
      assert.equal(options.timeout, 15_000);
    }
  };

  const captured = await captureGoAuthorization(
    {
      async newPage() {
        actions.push("新建空白页");
        return page;
      }
    },
    "wrk_Target9",
    new AbortController().signal,
    async (receivedPage, workspaceId) => {
      actions.push("登记响应等待");
      assert.equal(receivedPage, page);
      assert.equal(workspaceId, "wrk_Target9");
      return goRequest;
    }
  );

  assert.deepEqual(actions, ["新建空白页", "登记响应等待", "触发导航"]);
  assert.equal(captured.page, page);
  assert.deepEqual(captured.goRequest, goRequest);
});

test("为已识别工作区构造经严格校验的 V2 会话包", async () => {
  const module = await import("./auth-setup");
  const buildSessionBundle = (module as Record<string, unknown>)
    .buildSessionBundle as (
      workspaceId: string,
      authCookie: string,
      goRequest: { url: string; method: string; headers: Record<string, string> },
      usageList: unknown
    ) => { version: number; workspaceId: string; auth: { cookie: string }; goRequest: unknown };

  const bundle = buildSessionBundle(
    "wrk_Target9",
    "cookie-value",
    {
      url: "https://opencode.ai/workspace/wrk_Target9/go",
      method: "GET",
      headers: { accept: "text/html" }
    },
    {
      firstPage: {
        url: usageGetUrl("wrk_Target9", 0),
        method: "GET",
        headers: {}
      },
      pagination: { mode: "single-page" }
    }
  );

  assert.equal(bundle.version, 2);
  assert.equal(bundle.workspaceId, "wrk_Target9");
  assert.equal(bundle.auth.cookie, "auth=cookie-value");
  assert.deepEqual(bundle.goRequest, {
    url: "https://opencode.ai/workspace/wrk_Target9/go",
    method: "GET",
    headers: { accept: "text/html" }
  });
});

test("上传会话包时仅通过子进程标准输入传递敏感内容", async () => {
  const secret = '{"auth":{"cookie":"auth=不应泄露"}}';
  const received: Buffer[] = [];
  const logs: string[] = [];
  let command = "";
  let args: readonly string[] = [];
  let environment: NodeJS.ProcessEnv | undefined;

  const emitter = new EventEmitter();
  const child = emitter as unknown as UploadChild & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.stdin.on("data", (chunk: Buffer) => received.push(chunk));

  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    await uploadSessionBundle(secret, new AbortController().signal, {
      spawn(commandName, commandArgs, options) {
        command = commandName;
        args = commandArgs;
        environment = options.env;
        queueMicrotask(() => emitter.emit("close", 0));
        return child;
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(command, process.execPath);
  assert.match(args[0] ?? "", /[\\/]node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/u);
  assert.deepEqual(args.slice(1), ["secret", "put", "OPENCODE_SESSION_BUNDLE"]);
  assert.equal(Buffer.concat(received).toString("utf8"), secret);
  assert.equal(args.some((item) => item.includes(secret)), false);
  assert.equal(Object.values(environment ?? {}).some((item) => item?.includes(secret)), false);
  assert.equal(logs.some((item) => item.includes(secret)), false);
});

test("浏览器关闭失败时仍清理资料目录", async () => {
  const actions: string[] = [];

  await assert.rejects(
    cleanUpBrowserProfile(
      { close: async () => {
        actions.push("关闭浏览器");
        throw new Error("关闭失败");
      } },
      "C:\\临时资料目录",
      async () => { actions.push("删除目录"); }
    ),
    /关闭失败/u
  );
  assert.deepEqual(actions, ["关闭浏览器", "删除目录"]);
});

test("调用方提供的浏览器资料只关闭浏览器而不删除目录", async () => {
  const actions: string[] = [];

  await cleanUpBrowserProfile(
    { close: async () => { actions.push("关闭浏览器"); } },
    "C:\\持久授权资料",
    async () => { actions.push("删除目录"); },
    false
  );

  assert.deepEqual(actions, ["关闭浏览器"]);
});

test("上传输入失败时终止仍在运行的上传子进程", async () => {
  let killed = 0;
  const emitter = new EventEmitter();
  const child = emitter as unknown as UploadChild & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.kill = () => {
    killed += 1;
    return true;
  };

  const uploading = uploadSessionBundle("秘密会话", new AbortController().signal, {
    spawn() {
      queueMicrotask(() => child.stdin.emit("error", new Error("输入失败")));
      return child;
    }
  });

  await assert.rejects(uploading, /上传输入失败/u);
  assert.equal(killed, 1);
});

test("上传开始前已取消时不启动子进程", async () => {
  const controller = new AbortController();
  controller.abort(new Error("用户取消上传"));
  let spawnCalls = 0;

  await assert.rejects(
    uploadSessionBundle("秘密会话", controller.signal, {
      spawn() {
        spawnCalls += 1;
        throw new Error("不得启动");
      }
    }),
    /用户取消上传/u
  );
  assert.equal(spawnCalls, 0);
});

test("上传期间取消时终止子进程并等待关闭后拒绝", async () => {
  const controller = new AbortController();
  const emitter = new EventEmitter();
  const child = emitter as unknown as UploadChild & { stdin: PassThrough };
  child.stdin = new PassThrough();
  let killed = 0;
  child.kill = () => {
    killed += 1;
    return true;
  };

  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const uploading = uploadSessionBundle("秘密会话", controller.signal, {
    spawn() {
      return child;
    }
  });
  void uploading.then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; }
  );

  controller.abort(new Error("用户取消上传"));
  await Promise.resolve();
  const outcomeBeforeClose = outcome;
  const killedBeforeClose = killed;
  emitter.emit("close", 0);

  await assert.rejects(uploading, /用户取消上传/u);
  assert.equal(killedBeforeClose, 1);
  assert.equal(outcomeBeforeClose, "pending");
  assert.equal(outcome, "rejected");
});
