import { describe, expect, it } from "vitest";
import type { DashboardQuotaRow } from "../src/usage-dashboard-html";
import { renderUsageDashboardHtml } from "../src/usage-dashboard-html";

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
