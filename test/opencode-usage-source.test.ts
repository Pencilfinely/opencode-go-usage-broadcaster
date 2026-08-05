import { describe, expect, it } from "vitest";
import {
  OpenCodeUsageListSource
} from "../src/opencode-usage-source";
import type { UsagePaginationAuthorization } from "../src/opencode-session";

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

describe("OpenCode 用量明细分页来源", () => {
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
});
