import type { WindowKey } from "./domain";
import type { UsageDetailsView, UsageUnavailableReason } from "./usage-domain";

export const DASHBOARD_CONTENT_BUDGET = 18_000;

export interface DashboardQuotaRow {
  key: WindowKey;
  label: string;
  usedPercent: number;
  resetText: string;
}

export interface UsageDashboardInput {
  testData: boolean;
  statusLabel: "整点用量" | "手动用量";
  observedAtText: string;
  quotaRows: readonly DashboardQuotaRow[];
  usageDetails: UsageDetailsView;
  eventId: string;
}

export interface UsageDashboardRenderOptions {
  contentBudget?: number;
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function progressPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

type DashboardVariant = "rich" | "compatibility";

const USAGE_UNAVAILABLE_COPY: Record<UsageUnavailableReason, string> = {
  "not-authorized": "24 小时明细尚未授权，请重新运行授权工具。",
  "single-page-full": "24 小时明细分页尚未授权，请重新运行授权工具。",
  auth: "24 小时明细登录已失效，请重新运行授权工具。",
  transient: "24 小时明细暂时不可用，本次额度数据不受影响。",
  schema: "24 小时明细格式已变化，请更新采集适配器。"
};

function renderUsageDetails(usageDetails: UsageDetailsView): string {
  if (usageDetails.status === "unavailable") {
    return USAGE_UNAVAILABLE_COPY[usageDetails.reason];
  }
  return "24 小时明细已获取。";
}

function renderQuotaRow(row: DashboardQuotaRow): string {
  const percent = progressPercent(row.usedPercent);
  const progress = String(percent) + "%";
  const key = escapeHtmlText(row.key);
  return `<tr data-quota="${key}"><td>${escapeHtmlText(row.label)}<br>重置：${escapeHtmlText(row.resetText)}</td><td bgcolor="#e5e7eb" style="background-color:#e5e7eb"><table width="100%" role="presentation" cellspacing="0" cellpadding="0"><tr><td data-quota-progress="${key}" width="${progress}" bgcolor="#2563eb" style="background-color:#2563eb">&nbsp;</td><td bgcolor="#e5e7eb" style="background-color:#e5e7eb">&nbsp;</td></tr></table></td><td>${progress}</td></tr>`;
}

function renderDashboardVariant(
  input: UsageDashboardInput,
  variant: DashboardVariant
): string {
  const title = (input.testData ? "【测试数据】" : "") +
    "OpenCode Go " + escapeHtmlText(input.statusLabel);
  const quotaRows = input.quotaRows.map(renderQuotaRow).join("");
  const tableStyle = variant === "rich"
    ? ' style="border-collapse:collapse;font-family:Arial,sans-serif"'
    : "";

  return `<table width="100%"${tableStyle} data-dashboard-variant="${variant}" role="presentation" cellspacing="0" cellpadding="8"><tr><td><strong>${title}</strong></td></tr><tr><td>观察时间：${escapeHtmlText(input.observedAtText)}</td></tr><tr><td><table width="100%" role="presentation" cellspacing="0" cellpadding="6"><tbody>${quotaRows}</tbody></table></td></tr><tr><td>${renderUsageDetails(input.usageDetails)}</td></tr><tr><td>观察时间：${escapeHtmlText(input.observedAtText)}<br>当前小时为部分小时，仅统计至观察时间。<br>事件：${escapeHtmlText(input.eventId)}</td></tr></table>`;
}

export function renderUsageDashboardHtml(
  input: UsageDashboardInput,
  options: UsageDashboardRenderOptions = {}
): string {
  const rich = renderDashboardVariant(input, "rich");
  const contentBudget = options.contentBudget ?? DASHBOARD_CONTENT_BUDGET;
  return rich.length <= contentBudget
    ? rich
    : renderDashboardVariant(input, "compatibility");
}
