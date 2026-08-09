import { describe, expect, it } from "vitest";
import type { DashboardQuotaRow } from "../src/usage-dashboard-html";
import {
  DASHBOARD_CONTENT_BUDGET,
  renderUsageDashboardHtml
} from "../src/usage-dashboard-html";
import type { UsageAggregate, UsageHourBucket } from "../src/usage-domain";

function hourlyBuckets(values: readonly number[]): UsageHourBucket[] {
  return values.map((value, index) => ({
    startAt: Date.UTC(2026, 7, 7, 16) + index * 60 * 60 * 1000,
    inputTokens: index === 0 ? 40 : value,
    outputTokens: index === 0 ? 30 : 0,
    reasoningTokens: index === 0 ? 20 : 0,
    cacheTokens: index === 0 ? 10 : 0
  }));
}

function availableInput(aggregate: UsageAggregate, overrides: Partial<{
  eventId: string;
}> = {}) {
  return {
    testData: false,
    statusLabel: "整点用量" as const,
    observedAtText: "08月8日 00:00",
    quotaRows: [
      { key: "rolling" as const, label: "5 小时额度", usedPercent: 49, resetText: "08月8日 05:00" },
      { key: "weekly" as const, label: "每周额度", usedPercent: 20, resetText: "08月15日 00:00" },
      { key: "monthly" as const, label: "每月额度", usedPercent: 10, resetText: "09月1日 00:00" }
    ],
    usageDetails: { status: "available" as const, aggregate },
    eventId: overrides.eventId ?? "event-available"
  };
}

function completeAggregate(): UsageAggregate {
  return {
    observedAt: Date.UTC(2026, 7, 8),
    windowStartAt: Date.UTC(2026, 7, 7),
    truncated: false,
    requestCount: 7,
    costMicroCents: 123_456_789,
    tokens: {
      inputTokens: 41,
      outputTokens: 30,
      reasoningTokens: 20,
      cacheTokens: 10,
      totalTokens: 101
    },
    buckets: hourlyBuckets([100, 1, ...Array(22).fill(0)]),
    models: [
      { model: "模型一", tokenCount: 50, sharePercent: 49.5 },
      { model: "模型二", tokenCount: 20, sharePercent: 19.8 },
      { model: "模型三", tokenCount: 10, sharePercent: 9.9 },
      { model: "模型四", tokenCount: 8, sharePercent: 7.9 },
      { model: "模型五", tokenCount: 7, sharePercent: 6.9 },
      { model: "其他", tokenCount: 6, sharePercent: 5.9 }
    ]
  };
}

describe("PushPlus 仪表盘外壳", () => {
  it("渲染额度进度、未授权说明和安全页脚", () => {
    const quotaRows: DashboardQuotaRow[] = [
      { key: "rolling", label: "5 小时额度", usedPercent: 49, resetText: "08月3日 14:00" },
      { key: "weekly", label: "每周额度", usedPercent: 20, resetText: "08月9日 08:00" },
      { key: "monthly", label: "每月额度", usedPercent: 10, resetText: "09月1日 08:00" }
    ];

    const content = renderUsageDashboardHtml({
      testData: true,
      statusLabel: "手动用量",
      observedAtText: "08月3日 09:00",
      quotaRows,
      usageDetails: { status: "unavailable", reason: "not-authorized" },
      eventId: "event<quota>"
    });

    expect(content).toContain("【测试数据】OpenCode Go 手动用量");
    expect(content).toContain("08月3日 09:00");
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
  });

  it("为轨道和填充单元格同时提供兼容背景色", () => {
    const content = renderUsageDashboardHtml({
      testData: false,
      statusLabel: "整点用量",
      observedAtText: "08月3日 09:00",
      quotaRows: [
        { key: "rolling", label: "5 小时额度", usedPercent: 49, resetText: "08月3日 14:00" },
        { key: "weekly", label: "每周额度", usedPercent: 20, resetText: "08月9日 08:00" },
        { key: "monthly", label: "每月额度", usedPercent: 10, resetText: "09月1日 08:00" }
      ],
      usageDetails: { status: "unavailable", reason: "not-authorized" },
      eventId: "event-compatibility"
    });

    expect(content).toMatch(/bgcolor="#e5e7eb" style="background-color:#e5e7eb"/);
    expect(content).toMatch(/bgcolor="#2563eb" style="background-color:#2563eb"/);
    expect(content).toContain('<table width="100%"');
  });
});

describe("PushPlus 完整用量仪表盘", () => {
  it("渲染完整数据、零值和安全边界", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));

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

    const hourValues = [...content.matchAll(/data-hour-value="(\d{2})"/g)]
      .map((match) => match[1]);
    for (let index = 0; index < 12; index += 1) {
      expect(hourValues.slice(index * 2, index * 2 + 2)).toEqual([
        String(index).padStart(2, "0"),
        String(index + 12).padStart(2, "0")
      ]);
    }
    expect(content).toMatch(/data-hour-value="00"[\s\S]*?>[\s\S]*?>100</);
    expect(content).toMatch(/data-hour-value="01"[\s\S]*?>[\s\S]*?>1</);
    expect(content).toMatch(/data-hour-value="02"[\s\S]*?>[\s\S]*?>0</);
    expect(content).toMatch(/data-hour-value="00"[\s\S]*?data-mini-bar="00"[\s\S]*?width="100%"/);
    expect(content).toMatch(/data-hour-value="01"[\s\S]*?data-mini-bar="01"[\s\S]*?width="1%"/);
    expect(content).toMatch(/data-hour-value="02"[\s\S]*?data-mini-bar="02"[\s\S]*?width="0%"/);
    expect(content).toContain(">7<");
    expect(content).toContain(">101<");
    expect(content).toContain("$1.2346");
    expect(content).toContain(">41<");
    expect(content).toContain(">30<");
    expect(content).toContain(">20<");
    expect(content).toContain(">10<");
    expect(content).toMatch(/模型一[\s\S]*?50[\s\S]*?49\.5%[\s\S]*?模型二[\s\S]*?20[\s\S]*?19\.8%[\s\S]*?模型三[\s\S]*?10[\s\S]*?9\.9%[\s\S]*?模型四[\s\S]*?8[\s\S]*?7\.9%[\s\S]*?模型五[\s\S]*?7[\s\S]*?6\.9%[\s\S]*?其他[\s\S]*?6[\s\S]*?5\.9%/);
    expect(content).not.toMatch(/<(?:img|svg|canvas|script|style)\b/i);
    expect(content).not.toMatch(/display\s*:\s*(?:flex|grid)|position\s*:/i);
    expect(content).not.toMatch(/[█░]/);

    const realTags = content.match(/<[^>]+>/g)?.join("") ?? "";
    expect(realTags).not.toMatch(/\b(?:src|href)\s*=/i);
    expect(realTags).not.toMatch(/url\s*\(/i);
  });

  it("为全零数据保留完整结构和零值", () => {
    const aggregate = completeAggregate();
    aggregate.requestCount = 0;
    aggregate.costMicroCents = 0;
    aggregate.tokens = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0
    };
    aggregate.buckets = hourlyBuckets(Array(24).fill(0)).map((bucket) => ({
      ...bucket,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0
    }));
    aggregate.models = [];

    const content = renderUsageDashboardHtml(availableInput(aggregate));
    expect(content).toContain(">0<");
    expect(content).toContain("$0.0000");
    expect(content.match(/data-hour-bar="\d{2}"[^>]*height:0/g)).toHaveLength(24);
    expect(content.match(/data-hour-value="\d{2}"[\s\S]*?>0<\/td>/g)).toHaveLength(24);
    expect(content).toContain("暂无模型记录");
  });

  it("为长数值、模型名、截断和预算降级保留确定性信息", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const aggregate: UsageAggregate = {
      observedAt: Date.UTC(2026, 7, 8),
      windowStartAt: Date.UTC(2026, 7, 7),
      truncated: true,
      requestCount: 24,
      costMicroCents: 123_456_789,
      tokens: {
        inputTokens: maximum,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheTokens: 0,
        totalTokens: maximum
      },
      buckets: hourlyBuckets(Array(24).fill(maximum)).map((bucket) => ({
        ...bucket,
        inputTokens: maximum,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheTokens: 0
      })),
      models: [
        { model: "甲".repeat(64), tokenCount: maximum, sharePercent: 100 },
        { model: "乙".repeat(65), tokenCount: maximum, sharePercent: 50 },
        { model: "<img src=x>", tokenCount: maximum, sharePercent: 25 }
      ]
    };
    const input = availableInput(aggregate, { eventId: "event-budget" });
    const rich = renderUsageDashboardHtml(input, {
      contentBudget: Number.MAX_SAFE_INTEGER
    });

    expect(rich).toContain('data-dashboard-variant="rich"');
    expect(rich).toContain("9,007,199,254,740,991");
    expect(rich).toContain('data-hour-layout="single"');
    expect([...rich.matchAll(/data-hour-value="(\d{2})"/g)].map((match) => match[1]))
      .toEqual(Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0")));
    expect(rich).toContain("甲".repeat(64));
    expect(rich).toContain("乙".repeat(63) + "…");
    expect(rich).toContain("&lt;img src=x&gt;");
    expect(rich).not.toContain("<img src=x>");
    expect(rich).toContain("至少24");
    expect(rich).toContain("至少9,007,199,254,740,991");
    expect(rich).toContain("至少0");
    expect(rich).toContain("至少$1.2346");
    expect(rich).toContain("至少100.0%");
    expect(rich).toContain("仅含已采集的最新记录");

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
  });
});
