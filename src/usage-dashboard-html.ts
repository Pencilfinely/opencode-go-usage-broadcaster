import type { WindowKey } from "./domain";
import type {
  UsageAggregate,
  UsageDetailsView,
  UsageHourBucket,
  UsageUnavailableReason
} from "./usage-domain";

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

const integerFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0
});

const hourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hourCycle: "h23"
});

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

function bucketTotal(bucket: UsageHourBucket): number {
  return bucket.inputTokens + bucket.outputTokens +
    bucket.reasoningTokens + bucket.cacheTokens;
}

function barHeight(total: number, maximum: number): number {
  if (total === 0 || maximum === 0) return 0;
  return Math.min(88, Math.max(3, Math.round(total / maximum * 88)));
}

function miniBarPercent(total: number, maximum: number): number {
  if (total === 0 || maximum === 0) return 0;
  return Math.min(100, Math.max(1, Math.round(total / maximum * 100)));
}

function modelDisplayName(value: string): string {
  const codePoints = Array.from(value);
  const display = codePoints.length <= 64
    ? value
    : codePoints.slice(0, 63).join("") + "…";
  return escapeHtmlText(display);
}

function usageValue(value: number, truncated: boolean): string {
  return (truncated ? "至少" : "") + integerFormat.format(value);
}

function costValue(costMicroCents: number, truncated: boolean): string {
  return (truncated ? "至少" : "") +
    "$" + (costMicroCents / 100000000).toFixed(4);
}

interface HourValue {
  hour: string;
  rawValue: number;
  displayValue: string;
  miniPercent: number;
}

function hourlyValues(aggregate: UsageAggregate): HourValue[] {
  const totals = aggregate.buckets.map(bucketTotal);
  const maximum = Math.max(0, ...totals);
  return aggregate.buckets.map((bucket, index) => {
    const rawValue = totals[index] ?? 0;
    return {
      hour: hourFormat.format(new Date(bucket.startAt)),
      rawValue,
      displayValue: integerFormat.format(rawValue),
      miniPercent: miniBarPercent(rawValue, maximum)
    };
  });
}

function renderSummary(aggregate: UsageAggregate): string {
  return `<table data-section="summary" width="100%" role="presentation" cellspacing="0" cellpadding="6"><tr><td>最近 24 小时请求数<br><strong>${usageValue(aggregate.requestCount, aggregate.truncated)}</strong></td><td>总 Token<br><strong>${usageValue(aggregate.tokens.totalTokens, aggregate.truncated)}</strong></td><td>费用<br><strong>${costValue(aggregate.costMicroCents, aggregate.truncated)}</strong></td></tr></table>`;
}

function renderHourlyChart(aggregate: UsageAggregate): string {
  const totals = aggregate.buckets.map(bucketTotal);
  const maximum = Math.max(0, ...totals);
  const bars = aggregate.buckets.map((bucket, index) => {
    const hour = hourFormat.format(new Date(bucket.startAt));
    const height = barHeight(totals[index] ?? 0, maximum);
    const bar = height === 0
      ? `<td data-hour-bar="${hour}" height="0" style="height:0px"></td>`
      : `<td data-hour-bar="${hour}" height="${height}" bgcolor="#2563eb" style="height:${height}px;background-color:#2563eb">&nbsp;</td>`;
    return `<td height="88" valign="bottom"><table><tr>${bar}</tr></table></td>`;
  }).join("");
  return `<table data-section="hourly-chart" width="100%" role="presentation" cellspacing="1" cellpadding="0"><tr>${bars}</tr><tr><td colspan="6">00</td><td colspan="6">06</td><td colspan="6">12</td><td colspan="6">18</td></tr></table>`;
}

function renderTokenBreakdown(aggregate: UsageAggregate): string {
  const { tokens, truncated } = aggregate;
  return `<table data-section="token-breakdown" width="100%" role="presentation" cellspacing="0" cellpadding="6"><tr><td>输入<br><strong>${usageValue(tokens.inputTokens, truncated)}</strong></td><td>输出<br><strong>${usageValue(tokens.outputTokens, truncated)}</strong></td></tr><tr><td>推理<br><strong>${usageValue(tokens.reasoningTokens, truncated)}</strong></td><td>缓存<br><strong>${usageValue(tokens.cacheTokens, truncated)}</strong></td></tr></table>`;
}

function renderHourValue(value: HourValue, includeMiniBar: boolean): string {
  const miniBar = !includeMiniBar ? "" : value.miniPercent === 0
    ? `<table data-mini-bar="${value.hour}"><tr><td width="0%"></td></tr></table>`
    : `<table data-mini-bar="${value.hour}"><tr><td width="${value.miniPercent}%" bgcolor="#2563eb" style="background-color:#2563eb">&nbsp;</td></tr></table>`;
  return `<table data-hour-value="${value.hour}"><tr><td>${value.hour}</td><td>${miniBar}</td><td>${value.displayValue}</td></tr></table>`;
}

function renderHourlyExact(aggregate: UsageAggregate, variant: DashboardVariant): string {
  const values = hourlyValues(aggregate);
  const single = values.some((value) => value.displayValue.length > 10);
  const includeMiniBar = variant === "rich";
  const rows = single
    ? values.map((value) => `<tr><td>${renderHourValue(value, includeMiniBar)}</td></tr>`).join("")
    : Array.from({ length: 12 }, (_, index) =>
      `<tr><td>${renderHourValue(values[index]!, includeMiniBar)}</td><td>${renderHourValue(values[index + 12]!, includeMiniBar)}</td></tr>`
    ).join("");
  const layout = single ? "single" : "double";
  return `<table data-section="hourly-exact" data-hour-layout="${layout}" width="100%" role="presentation" cellspacing="0" cellpadding="2">${rows}</table>`;
}

function renderModels(aggregate: UsageAggregate): string {
  const { models, truncated } = aggregate;
  if (models.length === 0) {
    return `<table data-section="models" width="100%" role="presentation" cellspacing="0" cellpadding="6"><tr><td>暂无模型记录</td></tr></table>`;
  }
  const rows = models.map((model) =>
    `<tr><td>${modelDisplayName(model.model)}</td><td>${usageValue(model.tokenCount, truncated)}</td><td>${truncated ? "至少" : ""}${model.sharePercent.toFixed(1)}%</td></tr>`
  ).join("");
  return `<table data-section="models" width="100%" role="presentation" cellspacing="0" cellpadding="6"><tr><td>模型</td><td>Token</td><td>占比</td></tr>${rows}</table>`;
}

function renderAvailableDetails(
  aggregate: UsageAggregate,
  variant: DashboardVariant
): string {
  const chart = variant === "rich" ? renderHourlyChart(aggregate) : "";
  const truncatedCopy = aggregate.truncated
    ? "<tr><td>数据已截断，汇总数值均为至少已采集范围。</td></tr>"
    : "";
  return `<tr><td>${renderSummary(aggregate)}</td></tr>${chart === "" ? "" : `<tr><td>${chart}</td></tr>`}<tr><td>${renderTokenBreakdown(aggregate)}</td></tr><tr><td>${renderHourlyExact(aggregate, variant)}</td></tr><tr><td>${renderModels(aggregate)}</td></tr>${truncatedCopy}`;
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
  const availableDetails = input.usageDetails.status === "available"
    ? renderAvailableDetails(input.usageDetails.aggregate, variant)
    : `<tr><td>${renderUsageDetails(input.usageDetails)}</td></tr>`;
  const footer = input.usageDetails.status === "available" &&
    input.usageDetails.aggregate.truncated
    ? "仅含已采集的最新记录。"
    : "当前小时为部分小时，仅统计至观察时间。";

  return `<table width="100%"${tableStyle} data-dashboard-variant="${variant}" role="presentation" cellspacing="0" cellpadding="8"><tr><td><strong>${title}</strong></td></tr><tr><td>观察时间：${escapeHtmlText(input.observedAtText)}</td></tr><tr><td><table width="100%" role="presentation" cellspacing="0" cellpadding="6"><tbody>${quotaRows}</tbody></table></td></tr>${availableDetails}<tr><td>观察时间：${escapeHtmlText(input.observedAtText)}<br>${footer}<br>事件：${escapeHtmlText(input.eventId)}</td></tr></table>`;
}

export function renderUsageDashboardHtml(
  input: UsageDashboardInput,
  options: UsageDashboardRenderOptions = {}
): string {
  const budget = options.contentBudget ?? DASHBOARD_CONTENT_BUDGET;
  const rich = renderDashboardVariant(input, "rich");
  if (rich.length <= budget) return rich;

  const compatibility = renderDashboardVariant(input, "compatibility");
  if (compatibility.length <= budget) return compatibility;

  throw new RangeError(`PushPlus 仪表盘正文超过 ${budget} 字符安全预算`);
}
