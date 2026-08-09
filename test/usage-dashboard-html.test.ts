import { describe, expect, it } from "vitest";
import type { DashboardQuotaRow } from "../src/usage-dashboard-html";
import {
  DASHBOARD_CONTENT_BUDGET,
  renderUsageDashboardHtml
} from "../src/usage-dashboard-html";
import type { UsageAggregate, UsageHourBucket } from "../src/usage-domain";

const HOUR_ORDER = [
  "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
  "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23"
];

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

function hourItem(content: string, hour: string): string {
  const marker = `data-hour-value="${hour}"`;
  const start = content.indexOf(marker);
  const nextHour = content.indexOf("data-hour-value=", start + marker.length);
  const models = content.indexOf('data-section="models"', start + marker.length);
  const end = nextHour === -1 ? models : nextHour;
  return content.slice(start, end === -1 ? content.length : end);
}

function miniBarItem(content: string, hour: string): string {
  return content.match(new RegExp(
    `<table data-mini-bar="${hour}"[\\s\\S]*?<\\/table>`
  ))?.[0] ?? "";
}

function quotaItem(content: string, key: DashboardQuotaRow["key"]): string {
  const marker = `<table data-quota="${key}"`;
  const start = content.indexOf(marker);
  const nextQuota = content.indexOf("<table data-quota=", start + marker.length);
  const end = nextQuota === -1 ? content.indexOf("</tbody>", start) : nextQuota;
  return content.slice(start, end === -1 ? content.length : end);
}

function hourlyChartItem(content: string): string {
  const start = content.indexOf('data-section="hourly-chart"');
  const end = content.indexOf('data-section="token-breakdown"', start);
  return content.slice(start, end === -1 ? content.length : end);
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

describe("最终审查回归", () => {
  it("趋势轴按跨日桶的第 0、6、12、18 项显示真实小时", () => {
    const aggregate = completeAggregate();
    aggregate.buckets = aggregate.buckets.map((bucket, index) => ({
      ...bucket,
      startAt: Date.UTC(2026, 7, 8, 12) + index * 60 * 60 * 1000
    }));

    const content = renderUsageDashboardHtml(availableInput(aggregate));
    const axisHours = [...content.matchAll(
      /data-hour-axis="(?:0|6|12|18)"[^>]*>(\d{2})<\/td>/g
    )].map((match) => match[1]);
    const exactHours = [...content.matchAll(/data-hour-row="(\d{2})"/g)]
      .map((match) => match[1]);

    expect(axisHours).toEqual(["20", "02", "08", "14"]);
    expect(exactHours).toEqual([
      "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06", "07",
      "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19"
    ]);
  });

  it("精确值迷你条使用固定轨道和互补的填充与剩余单元格", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));
    const full = miniBarItem(content, "00");
    const small = miniBarItem(content, "01");
    const zero = miniBarItem(content, "02");

    expect(full).toMatch(/^<table data-mini-bar="00" width="100%" height="6"/);
    expect(full).toMatch(/<tr><td width="100%"[^>]*bgcolor="#2563eb"[^>]*><\/td><td width="0%"[^>]*><\/td><\/tr>/);
    expect(small).toMatch(/<tr><td width="1%"[^>]*bgcolor="#2563eb"[^>]*><\/td><td width="99%"[^>]*><\/td><\/tr>/);
    expect(zero).toMatch(/<tr><td width="0%"[^>]*><\/td><td width="100%"[^>]*><\/td><\/tr>/);
    expect(zero).not.toContain("#2563eb");
    expect(full + small + zero).not.toContain("&nbsp;");
  });

  it("顶部额度条在零和满格边界不渲染空段并兼容显示百分比", () => {
    const input = availableInput(completeAggregate());
    input.quotaRows = [
      { key: "rolling", label: "5 小时额度", usedPercent: 0, resetText: "08月9日 14:00" },
      { key: "weekly", label: "每周额度", usedPercent: 100, resetText: "08月10日 08:00" },
      { key: "monthly", label: "每月额度", usedPercent: 50, resetText: "09月1日 08:00" }
    ];

    const content = renderUsageDashboardHtml(input);
    const empty = quotaItem(content, "rolling");
    const full = quotaItem(content, "weekly");
    const half = quotaItem(content, "monthly");

    expect(empty).not.toContain('data-quota-progress="rolling"');
    expect(empty).toMatch(/data-quota-remaining="rolling" width="100%"/);
    expect(empty).not.toMatch(/bgcolor="#2563eb"|background-color:#2563eb/);
    expect(full).toMatch(/data-quota-progress="weekly" width="100%"[^>]*bgcolor="#2563eb"/);
    expect(full).not.toContain('data-quota-remaining="weekly"');
    expect(half).toMatch(/data-quota-progress="monthly" width="50%"/);
    expect(half).toMatch(/data-quota-remaining="monthly" width="50%"/);
    expect(empty).toContain('<table width="100%" height="8"');
    expect(full).toContain('<table width="100%" height="8"');
    expect(content).toMatch(/data-quota-percent="rolling" align="right" nowrap[^>]*>0%<\/td>/);
    expect(content).toMatch(/data-quota-percent="weekly" align="right" nowrap[^>]*>100%<\/td>/);
    expect(content).toMatch(/data-quota-reset="rolling"[^>]*color:#6b7280/);
    expect(empty + full + half).not.toContain("&nbsp;");
  });

  it("小时柱单元格保持空内容且嵌套表格归零间距", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));
    const chart = hourlyChartItem(content);
    const barCells = chart.match(/<td data-hour-bar="\d{2}"[^>]*><\/td>/g) ?? [];

    expect(barCells).toHaveLength(24);
    expect(chart).toMatch(/<table width="100%" cellspacing="0" cellpadding="0"><tr><td data-hour-bar="01"/);
    expect(chart).not.toContain("&nbsp;");
  });

  it("普通长度的 24 小时精确值也逐小时独占单列", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));
    const hours = [...content.matchAll(/data-hour-row="(\d{2})"/g)]
      .map((match) => match[1]);

    expect(content).toContain("24 小时精确值（Token）");
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
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));
    const firstHour = hourItem(content, "00");

    expect(firstHour).toMatch(
      /<td[^>]*align="right"[^>]*style="[^"]*white-space:normal[^"]*"[^>]*>100<\/td>/
    );
    expect(firstHour).not.toMatch(/align="right"[^>]*nowrap/);
  });

  it("截断数据同时保留部分小时口径和截断提示", () => {
    const aggregate = completeAggregate();
    aggregate.truncated = true;

    const content = renderUsageDashboardHtml(availableInput(aggregate));

    expect(content).toContain("当前小时为部分小时，仅统计至观察时间。");
    expect(content).toContain("仅含已采集的最新记录。");
  });

  it("丰富版不注入未约定的字体族", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));

    expect(content).not.toMatch(/font-family/i);
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
    expect(content).toContain('data-hour-layout="single"');
    expect(content.match(/data-hour-value=/g)).toHaveLength(24);

    const hourValues = [...content.matchAll(/data-hour-value="(\d{2})"/g)]
      .map((match) => match[1]);
    expect(hourValues).toEqual(HOUR_ORDER);
    expect(hourItem(content, "00")).toContain(">100</td>");
    expect(hourItem(content, "01")).toContain(">1</td>");
    expect(hourItem(content, "02")).toContain(">0</td>");
    expect(hourItem(content, "00")).toContain('data-mini-bar="00"');
    expect(hourItem(content, "00")).toContain('width="100%"');
    expect(hourItem(content, "01")).toContain('data-mini-bar="01"');
    expect(hourItem(content, "01")).toContain('width="1%"');
    expect(hourItem(content, "02")).toContain('data-mini-bar="02"');
    expect(hourItem(content, "02")).toContain('width="0%"');
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
    expect([...content.matchAll(/data-hour-value="(\d{2})"/g)].map((match) => match[1]))
      .toEqual(HOUR_ORDER);
    const zeroHourItems = HOUR_ORDER.map((hour) => hourItem(content, hour));
    expect(zeroHourItems).toHaveLength(24);
    expect(zeroHourItems.every((item) => item.includes(">0</td>"))).toBe(true);
    const zeroBars = content.match(/<td data-hour-bar="\d{2}"[^>]*>.*?<\/td>/g) ?? [];
    expect(zeroBars).toHaveLength(24);
    for (const zeroBar of zeroBars) {
      expect(zeroBar).not.toMatch(/(?:bgcolor|background-color)=/);
      expect(zeroBar).not.toContain("&nbsp;");
    }
    const zeroMiniBars = content.match(/<table data-mini-bar="\d{2}"[^>]*>[\s\S]*?<\/table>/g) ?? [];
    expect(zeroMiniBars).toHaveLength(24);
    for (const zeroMiniBar of zeroMiniBars) {
      expect(zeroMiniBar).not.toContain("#2563eb");
      expect(zeroMiniBar).not.toContain("&nbsp;");
    }
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
      .toEqual(HOUR_ORDER);
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
    expect(compatible.match(/data-hour-row="\d{2}"/g)).toHaveLength(24);
    expect(compatible).not.toContain("data-mini-bar-row=");
    expect(compatible).toContain("9,007,199,254,740,991");
    expect(compatible).toContain("&lt;img src=x&gt;");
    expect(compatible).not.toContain("<img src=x>");
    expect(compatible).toContain("事件：event-budget");
    expect(compatible.length).toBeLessThanOrEqual(DASHBOARD_CONTENT_BUDGET);

    const production = renderUsageDashboardHtml(input);
    expect(production.length).toBeLessThanOrEqual(DASHBOARD_CONTENT_BUDGET);
    expect(() => renderUsageDashboardHtml(input, { contentBudget: 1 }))
      .toThrow(RangeError);
  });
});
