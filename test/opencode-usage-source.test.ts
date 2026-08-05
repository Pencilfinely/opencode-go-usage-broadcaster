import { describe, expect, it } from "vitest";
import {
  OpenCodeUsageListSource
} from "../src/opencode-usage-source";
import { replayOpenCodeRequest } from "../src/opencode-http";
import type { UsagePaginationAuthorization } from "../src/opencode-session";

const USAGE_FUNCTION_ID = "0123456789abcdef".repeat(4);

function usageUrl(page: number): string {
  const url = new URL("https://opencode.ai/_server");
  url.searchParams.set("id", USAGE_FUNCTION_ID);
  url.searchParams.set("args", JSON.stringify({
    t: {
      t: 9,
      i: 0,
      l: 2,
      a: [{ t: 1, s: "wrk_abc" }, { t: 0, s: page }],
      o: 0
    },
    f: 31,
    m: []
  }));
  return url.toString();
}

function urlPageTemplate(): { location: "url"; prefix: string; suffix: string } {
  const zero = usageUrl(0);
  const one = usageUrl(1);
  let start = 0;
  while (zero[start] === one[start]) start += 1;
  let zeroEnd = zero.length;
  let oneEnd = one.length;
  while (zero[zeroEnd - 1] === one[oneEnd - 1]) {
    zeroEnd -= 1;
    oneEnd -= 1;
  }
  return { location: "url", prefix: zero.slice(0, start), suffix: zero.slice(zeroEnd) };
}

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
    template: urlPageTemplate()
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
        url: usageUrl(0),
        method: "GET",
        headers: { accept: "text/javascript" }
      },
      pagination
    }
  });
}

function makeRawV1Bundle(): string {
  return JSON.stringify({
    version: 1,
    generation: "generation-v1",
    createdAt: "2026-08-05T03:00:00.000Z",
    workspaceId: "wrk_abc",
    auth: { cookie: "auth=test-cookie" },
    request: {
      url: "https://opencode.ai/workspace/wrk_abc/go",
      method: "GET",
      headers: { accept: "text/html" }
    }
  });
}

function makePaginatedSource(input: {
  pages: unknown[][];
  onPage?: (page: number) => void;
}): OpenCodeUsageListSource {
  return new OpenCodeUsageListSource(
    makeRawV2Bundle(),
    async (url, _init) => {
      const args = JSON.parse(new URL(String(url)).searchParams.get("args") ?? "null") as {
        t: { a: [unknown, { s: number }] };
      };
      const page = args.t.a[1].s;
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

describe("OpenCode 用量明细分页来源", () => {
  it("以内部页号注入实例头，且会话包不保存任何 X-Server 头", async () => {
    const bundle = JSON.parse(makeRawV2Bundle()) as {
      usageList: { firstPage: { headers: Record<string, string> } };
    };
    expect(bundle.usageList.firstPage.headers["x-server-instance"]).toBeUndefined();
    expect(bundle.usageList.firstPage.headers["x-server-id"]).toBeUndefined();

    const calls: Array<{ page: number; headers: Headers }> = [];
    const source = new OpenCodeUsageListSource(
      makeRawV2Bundle(),
      async (url, init) => {
        const args = JSON.parse(new URL(String(url)).searchParams.get("args") ?? "null") as {
          t: { a: [unknown, { s: number }] };
        };
        const page = args.t.a[1].s;
        calls.push({ page, headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(page === 0 ? pageOf(50, 0) : pageOf(1, 50)), {
          headers: { "content-type": "application/json" }
        });
      }
    );

    await source.fetch(Date.parse("2026-08-05T03:30:00.000Z"));

    expect(calls.map(({ page, headers }) => ({
      page,
      cookie: headers.get("cookie"),
      instance: headers.get("x-server-instance"),
      serverId: headers.get("x-server-id")
    }))).toEqual([
      { page: 0, cookie: "auth=test-cookie", instance: "server-fn:0", serverId: null },
      { page: 1, cookie: "auth=test-cookie", instance: "server-fn:1", serverId: null }
    ]);
  });

  it("拒绝调用方提供无效实例头", async () => {
    let fetchCalls = 0;
    await expect(replayOpenCodeRequest(
      {
        url: usageUrl(0),
        method: "GET",
        headers: { accept: "text/javascript" }
      },
      "auth=test-cookie",
      async () => {
        fetchCalls += 1;
        return new Response("[]", { headers: { "content-type": "application/json" } });
      },
      undefined,
      { serverInstance: "server-fn:-1" }
    )).rejects.toMatchObject({ kind: "schema" });
    expect(fetchCalls).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "版本 1 在观察时间 %p 时立即降级且不发网络请求",
    async (observedAt) => {
      let fetchCalls = 0;
      const source = new OpenCodeUsageListSource(
        makeRawV1Bundle(),
        async () => {
          fetchCalls += 1;
          return new Response("测试不应发出请求");
        }
      );

      await expect(source.fetch(observedAt)).resolves.toEqual({
        status: "unavailable",
        reason: "not-authorized"
      });
      expect(fetchCalls).toBe(0);
    }
  );

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

  it("遇到窗口起点之前的记录后停止", async () => {
    const calls: number[] = [];
    const source = makePaginatedSource({
      pages: [pageOf(50, 0), [{
        id: "use_before_window",
        timeCreated: "2026-08-04T03:59:59.000Z",
        provider: "anthropic",
        model: "claude-sonnet",
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cost: 1
      }], pageOf(20, 100)],
      onPage: (page) => calls.push(page)
    });

    const result = await source.fetch(Date.parse("2026-08-05T03:30:00.000Z"));

    expect(calls).toEqual([0, 1]);
    expect(result).toMatchObject({ status: "complete", pagesRead: 2 });
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

  it("达到四十页时返回截断口径", async () => {
    const result = await makeFortyFullPagesSource().fetch(
      Date.parse("2026-08-05T03:30:00.000Z")
    );

    expect(result).toEqual(expect.objectContaining({
      status: "truncated",
      pagesRead: 40,
      reason: "page-limit"
    }));
  });

  it("响应后超过总预算时返回截止截断", async () => {
    let now = 0;
    const source = new OpenCodeUsageListSource(
      makeRawV2Bundle(),
      async () => {
        now = 25_000;
        return new Response(JSON.stringify(pageOf(1, 0)), {
          headers: { "content-type": "application/json" }
        });
      },
      () => now
    );

    await expect(source.fetch(Date.parse("2026-08-05T03:30:00.000Z"))).resolves.toEqual({
      status: "truncated",
      records: [],
      pagesRead: 1,
      reason: "deadline"
    });
  });

  it("回放前到达总预算时不发起网络请求", async () => {
    const clockValues = [0, 24_999, 25_000];
    let fetchCalls = 0;
    const source = new OpenCodeUsageListSource(
      makeRawV2Bundle(),
      async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify(pageOf(1, 0)), {
          headers: { "content-type": "application/json" }
        });
      },
      () => clockValues.shift() ?? 25_000
    );

    await expect(source.fetch(Date.parse("2026-08-05T03:30:00.000Z"))).resolves.toEqual({
      status: "truncated",
      records: [],
      pagesRead: 0,
      reason: "deadline"
    });
    expect(fetchCalls).toBe(0);
  });

  it("回放前用单次取时固定计时器预算", async () => {
    const clockValues = [0, 24_998, 24_999, 25_000];
    let fetchCalls = 0;
    let clockCalls = 0;
    const source = new OpenCodeUsageListSource(
      makeRawV2Bundle(),
      async () => {
        fetchCalls += 1;
        expect(clockCalls).toBe(3);
        return new Response(JSON.stringify(pageOf(1, 0)), {
          headers: { "content-type": "application/json" }
        });
      },
      () => {
        clockCalls += 1;
        return clockValues.shift() ?? 25_000;
      }
    );

    await expect(source.fetch(Date.parse("2026-08-05T03:30:00.000Z"))).resolves.toEqual({
      status: "truncated",
      records: [],
      pagesRead: 1,
      reason: "deadline"
    });
    expect(fetchCalls).toBe(1);
  });
});
