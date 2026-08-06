import { describe, expect, it } from "vitest";
import type { UsageAggregate } from "../src/usage-domain";
import {
  createUsageChartUrl,
  handleUsageChartRequest,
  parseUsageChartDataV1,
  renderUsageChartSvg,
  serializeUsageChartData,
  type UsageChartConfig,
  type UsageChartSnapshotReader
} from "../src/usage-chart";

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

function aggregate(): UsageAggregate {
  return {
    observedAt: Date.parse("2026-08-05T03:30:00.000Z"),
    windowStartAt: Date.parse("2026-08-04T04:00:00.000Z"),
    truncated: false,
    requestCount: 1,
    costMicroCents: 1,
    tokens: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 2
    },
    buckets: JSON.parse(validChartJson()).buckets,
    models: []
  };
}

describe("签名用量图表", () => {
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

  it.each([
    ["错误路径", (url: URL) => { url.pathname = "/charts/usage/invalid.svg"; }],
    ["篡改编号", (url: URL) => { url.pathname = "/charts/usage/" + "a".repeat(64) + ".svg"; }],
    ["篡改签名", (url: URL) => { url.searchParams.set("sig", "a".repeat(43)); }],
    ["重复查询", (url: URL) => { url.search += "&extra=1"; }],
    ["非 GET", (_url: URL) => undefined, { method: "POST" }],
    ["Cookie", (_url: URL) => undefined, { headers: { Cookie: "session=value" } }],
    ["Authorization", (_url: URL) => undefined, { headers: { Authorization: "Bearer value" } }]
  ])("%s 均统一返回空 404", async (_caseName, mutate, init?: RequestInit) => {
    const id = "b".repeat(64);
    const url = new URL(await createUsageChartUrl(config, id));
    mutate(url);

    const response = await handleUsageChartRequest(
      new Request(url, init),
      config,
      readerWith(id, validChartJson())
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["未知快照", readerWith("a".repeat(64), validChartJson())],
    ["损坏快照", readerWith("b".repeat(64), "{损坏")],
    ["仓库异常", {
      async loadUsageChartSnapshot() {
        throw new Error("存储不可用");
      }
    } satisfies UsageChartSnapshotReader]
  ])("%s 统一返回空 404", async (_caseName, reader) => {
    const id = "b".repeat(64);
    const response = await handleUsageChartRequest(
      new Request(await createUsageChartUrl(config, id)),
      config,
      reader
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("序列化只保留 V1 图表字段并拒绝不连续的二十四小时", () => {
    const raw = serializeUsageChartData(aggregate());
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      observedAt: aggregate().observedAt,
      truncated: false,
      buckets: aggregate().buckets
    });

    const damaged = JSON.parse(raw);
    damaged.buckets[23].startAt += 1;
    expect(() => parseUsageChartDataV1(JSON.stringify(damaged))).toThrow();
    expect(() => parseUsageChartDataV1(JSON.stringify({ ...JSON.parse(raw), extra: true })))
      .toThrow();
  });

  it("固定 SVG 不含脚本或外部资源，零值柱保持零高度", () => {
    const zero = aggregate();
    zero.buckets = zero.buckets.map((bucket) => ({
      ...bucket,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0
    }));

    const svg = renderUsageChartSvg(parseUsageChartDataV1(serializeUsageChartData(zero)));
    expect(svg).toContain('viewBox="0 0 720 360"');
    expect(svg.match(/<rect /gu)).toHaveLength(97);
    expect(svg).toContain('height="0.00"');
    expect(svg).toContain("#2563eb");
    expect(svg).toContain("#f59e0b");
    expect(svg).not.toMatch(/<(?:script|image|use|foreignObject)\b|\b(?:href|url\()/u);
  });
});
