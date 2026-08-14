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

const DISTINCT_HOUR_VALUES = [
  1_001, 2_002, 3_003, 4_004, 5_005, 6_006, 7_007, 8_008,
  9_009, 10_010, 11_011, 12_012, 13_013, 14_014, 15_015, 16_016,
  17_017, 18_018, 19_019, 20_020, 21_021, 22_022, 23_023, 24_024
];

const DISTINCT_HOUR_TEXT = [
  "1,001", "2,002", "3,003", "4,004", "5,005", "6,006",
  "7,007", "8,008", "9,009", "10,010", "11,011", "12,012",
  "13,013", "14,014", "15,015", "16,016", "17,017", "18,018",
  "19,019", "20,020", "21,021", "22,022", "23,023", "24,024"
];

type ScannedTableElement = {
  tag: "table" | "tbody" | "tr" | "td";
  openTag: string;
  innerHtml: string;
  outerHtml: string;
  children: ScannedTableElement[];
};

type PendingTableElement = ScannedTableElement & {
  contentStart: number;
  start: number;
};

function requiredItem<T>(items: readonly T[], index: number, description: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`缺少${description}：索引 ${index}`);
  }
  return item;
}

function scanTableElements(content: string): ScannedTableElement[] {
  const roots: ScannedTableElement[] = [];
  const stack: PendingTableElement[] = [];
  const tags = content.matchAll(/<\/?(table|tbody|tr|td)\b[^>]*>/gi);

  for (const match of tags) {
    const capturedTag = match[1];
    const position = match.index;
    if (capturedTag === undefined || position === undefined) {
      throw new Error("表格标签扫描结果缺少标签名或位置");
    }
    const tag = capturedTag.toLowerCase() as ScannedTableElement["tag"];
    const token = match[0];
    if (!token.startsWith("</")) {
      const element: PendingTableElement = {
        tag,
        openTag: token,
        innerHtml: "",
        outerHtml: "",
        children: [],
        contentStart: position + token.length,
        start: position
      };
      const parent = stack.at(-1);
      if (parent) {
        parent.children.push(element);
      } else {
        roots.push(element);
      }
      stack.push(element);
      continue;
    }

    const element = stack.pop();
    if (!element || element.tag !== tag) {
      throw new Error(`表格标签未平衡：${token}`);
    }
    element.innerHtml = content.slice(element.contentStart, position);
    element.outerHtml = content.slice(element.start, position + token.length);
  }

  if (stack.length > 0) {
    throw new Error(`表格标签未闭合：${stack.at(-1)?.openTag ?? ""}`);
  }
  return roots;
}

function attributeValue(element: ScannedTableElement, name: string): string | undefined {
  const attributes = element.openTag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g);
  for (const attribute of attributes) {
    if (attribute[1] === name) {
      return attribute[2] ?? attribute[3] ?? attribute[4];
    }
  }
  return undefined;
}

function taggedTable(content: string, name: string, value: string): ScannedTableElement {
  const tables = scanTableElements(content).flatMap(function collect(
    element: ScannedTableElement
  ): ScannedTableElement[] {
    return [element, ...element.children.flatMap(collect)];
  }).filter((element) => element.tag === "table");
  const table = tables.find((element) => attributeValue(element, name) === value);
  if (!table) {
    throw new Error(`找不到表格：${name}=${value}`);
  }
  return table;
}

function directChildren(
  element: ScannedTableElement,
  tag: ScannedTableElement["tag"]
): ScannedTableElement[] {
  return element.children.filter((child) => child.tag === tag);
}

function directTableRows(table: ScannedTableElement): ScannedTableElement[] {
  return table.children.flatMap((child) => {
    if (child.tag === "tr") {
      return [child];
    }
    return child.tag === "tbody" ? directChildren(child, "tr") : [];
  });
}

function directRowCells(row: ScannedTableElement): ScannedTableElement[] {
  return directChildren(row, "td");
}

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

describe("表格直接层级扫描器", () => {
  it("不会把嵌套双项同排误判为两个直接小时行", () => {
    const nestedDoubleItem = `<table data-section="hourly-exact"><tr data-hour-row="00"><td><table data-hour-value="00"><tr data-hour-meta="00"><td>00</td><td>1</td></tr></table></td><td><table data-hour-value="01"><tr data-hour-meta="01"><td>01</td><td>2</td></tr></table></td></tr></table>`;
    const exact = taggedTable(nestedDoubleItem, "data-section", "hourly-exact");
    const outerRow = requiredItem(directTableRows(exact), 0, "伪双列外层小时行");

    expect(nestedDoubleItem.match(/data-hour-value=/g)).toHaveLength(2);
    expect(directTableRows(exact)).toHaveLength(1);
    expect(directRowCells(outerRow)).toHaveLength(2);
  });
});

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
    const quotas = [
      { key: "rolling", label: "5 小时额度" },
      { key: "weekly", label: "每周额度" },
      { key: "monthly", label: "每月额度" }
    ] as const;

    for (const quota of quotas) {
      const table = taggedTable(content, "data-quota", quota.key);
      const rows = directTableRows(table);
      expect(rows).toHaveLength(2);

      const meta = requiredItem(rows, 0, `${quota.key} 额度元信息行`);
      const bar = requiredItem(rows, 1, `${quota.key} 额度进度条行`);
      expect(attributeValue(meta, "data-quota-meta")).toBe(quota.key);
      expect(directRowCells(meta)).toHaveLength(2);
      expect(meta.innerHtml).toContain(quota.label);
      expect(meta.innerHtml).toContain(`data-quota-reset="${quota.key}"`);
      expect(meta.innerHtml).toContain(`data-quota-percent="${quota.key}"`);
      expect(meta.innerHtml).not.toContain(`data-quota-track="${quota.key}"`);

      expect(attributeValue(bar, "data-quota-bar-row")).toBe(quota.key);
      const barCells = directRowCells(bar);
      expect(barCells).toHaveLength(1);
      const barCell = requiredItem(barCells, 0, `${quota.key} 额度进度条单元格`);
      expect(attributeValue(barCell, "colspan")).toBe("2");
      expect(attributeValue(barCell, "data-quota-track")).toBe(quota.key);
      expect(bar.innerHtml).not.toContain(`data-quota-percent="${quota.key}"`);
      expect(bar.innerHtml).not.toContain(`data-quota-reset="${quota.key}"`);
    }
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

    expect(full).toMatch(
      /^<table data-mini-bar="00" width=(?:"100%"|100%) height=(?:"6"|6)/
    );
    expect(full).toMatch(/<tr><td width="100%"[^>]*bgcolor="#2563eb"[^>]*><\/td><td width="0%"[^>]*><\/td><\/tr>/);
    expect(small).toMatch(/<tr><td width="1%"[^>]*bgcolor="#2563eb"[^>]*><\/td><td width="99%"[^>]*><\/td><\/tr>/);
    expect(zero).toMatch(/<tr><td width="0%"[^>]*><\/td><td width="100%"[^>]*><\/td><\/tr>/);
    expect(zero).not.toContain("#2563eb");
    expect(full + small + zero).not.toContain("&nbsp;");
  });

  it("每小时表和迷你条以全宽与归零间距渲染", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));
    const full = miniBarItem(content, "00");

    expect(content).toMatch(
      /<table data-hour-value="00" width=(?:"100%"|100%) role=(?:"presentation"|presentation) cellspacing=(?:"0"|0) cellpadding=(?:"0"|0)>/
    );
    expect(full).toMatch(
      /^<table data-mini-bar="00" width=(?:"100%"|100%) height=(?:"6"|6) cellspacing=(?:"0"|0) cellpadding=(?:"0"|0)/
    );
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
    const exact = taggedTable(content, "data-section", "hourly-exact");
    const rows = directTableRows(exact);
    const hourRows = rows.filter((row) => attributeValue(row, "data-hour-row") !== undefined);
    const hours = hourRows.map((row) => attributeValue(row, "data-hour-row"));

    expect(content).toContain("24 小时精确值（Token）");
    expect(content).toContain('data-hour-layout="single"');
    expect(rows).toHaveLength(25);
    expect(attributeValue(requiredItem(rows, 0, "精确值标题行"), "data-hour-row"))
      .toBeUndefined();
    expect(hours).toEqual(HOUR_ORDER);
    expect(hourRows).toHaveLength(24);
    expect(content).not.toContain('data-hour-layout="double"');

    for (const [index, hour] of HOUR_ORDER.entries()) {
      const hourRow = requiredItem(hourRows, index, `${hour} 小时外层行`);
      const outerCells = directRowCells(hourRow);
      expect(outerCells).toHaveLength(1);
      const outerCell = requiredItem(outerCells, 0, `${hour} 小时外层单元格`);
      const hourTables = directChildren(outerCell, "table");
      expect(hourTables).toHaveLength(1);
      const hourTable = requiredItem(hourTables, 0, `${hour} 小时数值表`);
      expect(attributeValue(hourTable, "data-hour-value")).toBe(hour);

      const valueRows = directTableRows(hourTable);
      expect(valueRows).toHaveLength(2);
      const metaRow = requiredItem(valueRows, 0, `${hour} 小时元信息行`);
      const miniRow = requiredItem(valueRows, 1, `${hour} 小时迷你条行`);
      expect(attributeValue(metaRow, "data-hour-meta")).toBe(hour);
      expect(attributeValue(miniRow, "data-mini-bar-row")).toBe(hour);
      const miniCells = directRowCells(miniRow);
      expect(miniCells).toHaveLength(1);
      const miniCell = requiredItem(miniCells, 0, `${hour} 小时迷你条单元格`);
      expect(attributeValue(miniCell, "colspan")).toBe("2");
      const miniTables = directChildren(miniCell, "table");
      expect(miniTables).toHaveLength(1);
      const miniTable = requiredItem(miniTables, 0, `${hour} 小时迷你条表`);
      expect(attributeValue(miniTable, "data-mini-bar")).toBe(hour);
    }
  });

  it("精确数值允许只在自身单元格内换行", () => {
    const content = renderUsageDashboardHtml(availableInput(completeAggregate()));
    const firstHour = hourItem(content, "00");

    expect(content).toMatch(
      /<table data-section="hourly-exact"[^>]*style="[^"]*white-space:normal[^"]*word-break:break-all[^"]*"/
    );
    expect(firstHour).toMatch(
      /<tr data-hour-meta="00"><td nowrap>00<\/td><td width="70%" align="right">100<\/td>/
    );
    expect(firstHour).not.toMatch(/<td width="70%" align="right"[^>]*nowrap/);
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

  it("兼容版逐桶保留 24 个不同的完整精确值和迷你条", () => {
    const aggregate = completeAggregate();
    aggregate.buckets = DISTINCT_HOUR_VALUES.map((value, index) => ({
      startAt: Date.UTC(2026, 7, 7, 16) + index * 60 * 60 * 1000,
      inputTokens: value,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0
    }));
    const input = availableInput(aggregate);
    const rich = renderUsageDashboardHtml(input, {
      contentBudget: Number.MAX_SAFE_INTEGER
    });
    const compatible = renderUsageDashboardHtml(input, {
      contentBudget: rich.length - 1
    });
    const exact = taggedTable(compatible, "data-section", "hourly-exact");
    const rows = directTableRows(exact);
    const hourRows = rows.filter((row) => attributeValue(row, "data-hour-row") !== undefined);

    expect(compatible).toContain('data-dashboard-variant="compatibility"');
    expect(rows).toHaveLength(25);
    expect(hourRows.map((row) => attributeValue(row, "data-hour-row")))
      .toEqual(HOUR_ORDER);

    for (const [index, hour] of HOUR_ORDER.entries()) {
      const hourRow = requiredItem(hourRows, index, `${hour} 小时兼容版外层行`);
      const outerCells = directRowCells(hourRow);
      expect(outerCells).toHaveLength(1);
      const outerCell = requiredItem(outerCells, 0, `${hour} 小时兼容版外层单元格`);
      const hourTables = directChildren(outerCell, "table");
      expect(hourTables).toHaveLength(1);
      const hourTable = requiredItem(hourTables, 0, `${hour} 小时兼容版数值表`);
      expect(attributeValue(hourTable, "data-hour-value")).toBe(hour);

      const valueRows = directTableRows(hourTable);
      expect(valueRows).toHaveLength(2);
      const metaRow = requiredItem(valueRows, 0, `${hour} 小时兼容版元信息行`);
      expect(attributeValue(metaRow, "data-hour-meta")).toBe(hour);
      const metaCells = directRowCells(metaRow);
      expect(metaCells).toHaveLength(2);
      const valueCell = requiredItem(metaCells, 1, `${hour} 小时兼容版数值单元格`);
      const expectedText = requiredItem(DISTINCT_HOUR_TEXT, index, `${hour} 小时期望值`);
      expect(valueCell.innerHtml).toBe(expectedText);

      const miniRow = requiredItem(valueRows, 1, `${hour} 小时兼容版迷你条行`);
      const miniCells = directRowCells(miniRow);
      expect(miniCells).toHaveLength(1);
      expect(attributeValue(requiredItem(miniCells, 0, `${hour} 小时兼容版迷你条单元格`), "colspan"))
        .toBe("2");
      expect(miniBarItem(hourTable.outerHtml, hour)).not.toBe("");
    }
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
    expect(compatible.match(/data-mini-bar="\d{2}"/g)).toHaveLength(24);
    expect(compatible.match(/data-hour-value=/g)).toHaveLength(24);
    expect(compatible.match(/data-hour-row="\d{2}"/g)).toHaveLength(24);
    expect(compatible).toContain("9,007,199,254,740,991");
    expect(compatible).toContain("&lt;img src=x&gt;");
    expect(compatible).not.toContain("<img src=x>");
    expect(compatible).toContain("事件：event-budget");
    expect(compatible.length).toBeLessThanOrEqual(DASHBOARD_CONTENT_BUDGET);

    const production = renderUsageDashboardHtml(input);
    expect(production.length).toBeLessThanOrEqual(DASHBOARD_CONTENT_BUDGET);
    expect(production.match(/data-mini-bar="\d{2}"/g)).toHaveLength(24);
    expect(() => renderUsageDashboardHtml(input, { contentBudget: 1 }))
      .toThrow(RangeError);
  });

  it("兼容版在最坏模型名转义下仍保留 24 条迷你条并满足正文预算", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const aggregate = completeAggregate();
    aggregate.tokens = {
      inputTokens: maximum,
      outputTokens: maximum,
      reasoningTokens: maximum,
      cacheTokens: maximum,
      totalTokens: maximum
    };
    aggregate.buckets = hourlyBuckets(Array(24).fill(maximum)).map((bucket) => ({
      ...bucket,
      inputTokens: maximum,
      outputTokens: maximum,
      reasoningTokens: maximum,
      cacheTokens: maximum
    }));
    aggregate.models = Array.from({ length: 6 }, () => ({
      model: '"'.repeat(64),
      tokenCount: maximum,
      sharePercent: 100
    }));

    const production = renderUsageDashboardHtml(availableInput(aggregate));

    expect(production).toContain('data-dashboard-variant="compatibility"');
    expect(production.length).toBeLessThanOrEqual(DASHBOARD_CONTENT_BUDGET);
    expect(production.match(/data-mini-bar="\d{2}"/g)).toHaveLength(24);
    expect(production.match(/data-hour-value="\d{2}"/g)).toHaveLength(24);
  });
});
