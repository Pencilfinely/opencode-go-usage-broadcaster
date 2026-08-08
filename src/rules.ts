import {
  WINDOW_KEYS,
  type QuotaSnapshot,
  type UsageWindow,
  type WindowKey
} from "./domain";
import type {
  UsageAggregate,
  UsageDetailsView,
  UsageModelTotal,
  UsageUnavailableReason
} from "./usage-domain";

export const THRESHOLDS = [50, 75, 90, 100] as const;
export type Threshold = (typeof THRESHOLDS)[number];

export interface PersistedWindow {
  usedPercent: number;
  resetAt: string;
  cycleBoundaryAt: string;
  cycleKey: string;
  consumed: Threshold[];
}

export interface QuotaState {
  windows: Record<WindowKey, PersistedWindow>;
  observationVersion: number;
}

export interface ThresholdItem {
  window: WindowKey;
  cycleKey: string;
  threshold: Threshold;
  usedPercent: number;
  resetAt: string;
}

export interface RuleEvaluation {
  state: QuotaState;
  startup: boolean;
  notifications: ThresholdItem[];
  consumptions: ThresholdItem[];
}

function initialWindow(value: UsageWindow): PersistedWindow {
  return {
    usedPercent: value.usedPercent,
    resetAt: value.resetAt,
    cycleBoundaryAt: value.resetAt,
    cycleKey: value.upstreamCycleId ?? "reset:" + value.resetAt,
    consumed: THRESHOLDS.filter((threshold) => value.usedPercent >= threshold)
  };
}

function isCredibleReset(
  previous: PersistedWindow,
  current: UsageWindow,
  nowMs: number
): boolean {
  if (
    current.upstreamCycleId &&
    current.upstreamCycleId !== previous.cycleKey
  ) {
    return true;
  }
  return (
    current.usedPercent < previous.usedPercent &&
    Date.parse(current.resetAt) > Date.parse(previous.resetAt) &&
    nowMs >= Date.parse(previous.cycleBoundaryAt) - 5 * 60 * 1000
  );
}

export function evaluateSnapshot(
  previous: QuotaState | null,
  snapshot: QuotaSnapshot,
  nowMs: number
): RuleEvaluation {
  if (!previous) {
    return {
      state: {
        windows: Object.fromEntries(
          WINDOW_KEYS.map((key) => [key, initialWindow(snapshot.windows[key])])
        ) as Record<WindowKey, PersistedWindow>,
        observationVersion: nowMs
      },
      startup: true,
      notifications: [],
      consumptions: []
    };
  }

  const notifications: ThresholdItem[] = [];
  const consumptions: ThresholdItem[] = [];
  const next = {} as Record<WindowKey, PersistedWindow>;

  for (const key of WINDOW_KEYS) {
    const oldWindow = previous.windows[key];
    const current = snapshot.windows[key];
    if (isCredibleReset(oldWindow, current, nowMs)) {
      next[key] = initialWindow(current);
      continue;
    }

    const consumed = new Set(oldWindow.consumed);
    const crossed = THRESHOLDS.filter(
      (threshold) =>
        oldWindow.usedPercent < threshold &&
        current.usedPercent >= threshold &&
        !consumed.has(threshold)
    );
    for (const threshold of crossed) {
      consumed.add(threshold);
      consumptions.push({
        window: key,
        cycleKey: oldWindow.cycleKey,
        threshold,
        usedPercent: current.usedPercent,
        resetAt: current.resetAt
      });
    }
    const highest = crossed.at(-1);
    if (highest !== undefined) {
      notifications.push({
        window: key,
        cycleKey: oldWindow.cycleKey,
        threshold: highest,
        usedPercent: current.usedPercent,
        resetAt: current.resetAt
      });
    }
    next[key] = {
      ...oldWindow,
      usedPercent: current.usedPercent,
      resetAt: current.resetAt,
      consumed: [...consumed].sort((a, b) => a - b)
    };
  }

  return {
    state: { windows: next, observationVersion: nowMs },
    startup: false,
    notifications,
    consumptions
  };
}

export interface RenderedMessage {
  title: string;
  content: string;
}

const WINDOW_LABELS: Record<WindowKey, string> = {
  rolling: "5 小时额度",
  weekly: "每周额度",
  monthly: "每月额度"
};

function formatReset(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function prefix(snapshot: QuotaSnapshot): string {
  return snapshot.source === "fixture" ? "【测试数据】" : "";
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const USAGE_UNAVAILABLE_COPY: Record<UsageUnavailableReason, string> = {
  "not-authorized": "24 小时明细尚未授权，请重新运行授权工具。",
  "single-page-full": "24 小时明细分页尚未授权，请重新运行授权工具。",
  auth: "24 小时明细登录已失效，请重新运行授权工具。",
  transient: "24 小时明细暂时不可用，本次额度数据不受影响。",
  schema: "24 小时明细格式已变化，请更新采集适配器。"
};

const numberFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0
});

function formatInteger(value: number): string {
  return numberFormat.format(value);
}

const inlineHourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hourCycle: "h23"
});

export function renderInlineUsageChart(aggregate: UsageAggregate): string[] {
  const totals = aggregate.buckets.map((bucket) =>
    bucket.inputTokens + bucket.outputTokens +
    bucket.reasoningTokens + bucket.cacheTokens
  );
  const maximum = Math.max(0, ...totals);
  return aggregate.buckets.map((bucket, index) => {
    const total = totals[index] ?? 0;
    const filled = total === 0 || maximum === 0
      ? 0
      : Math.min(10, Math.max(1, Math.ceil(total / maximum * 10)));
    return inlineHourFormat.format(new Date(bucket.startAt)) + "时" +
      "█".repeat(filled) + "░".repeat(10 - filled) + " " +
      formatInteger(total) + " Token";
  });
}

function formatQualified(value: string, truncated: boolean): string {
  return truncated ? "至少 " + value : value;
}

function formatModels(models: UsageModelTotal[], truncated: boolean): string {
  if (models.length === 0) return "暂无模型记录";
  return models.map((model) =>
    escapeHtmlText(model.model) +
    "：" +
    formatQualified(formatInteger(model.tokenCount), truncated) +
    " Token（" +
    formatQualified(model.sharePercent.toFixed(1) + "%", truncated) +
    "）"
  ).join("；");
}

function renderUsageDetails(usageDetails: UsageDetailsView): string[] {
  if (usageDetails.status === "unavailable") {
    return [USAGE_UNAVAILABLE_COPY[usageDetails.reason]];
  }
  const aggregate = usageDetails.aggregate;
  const rows = [
    "最近 24 小时请求数：" +
      formatQualified(formatInteger(aggregate.requestCount), aggregate.truncated),
    "最近 24 小时总 Token：" +
      formatQualified(formatInteger(aggregate.tokens.totalTokens), aggregate.truncated),
    "Token 分类：输入 " +
      formatQualified(formatInteger(aggregate.tokens.inputTokens), aggregate.truncated) +
      "；输出 " +
      formatQualified(formatInteger(aggregate.tokens.outputTokens), aggregate.truncated) +
      "；推理 " +
      formatQualified(formatInteger(aggregate.tokens.reasoningTokens), aggregate.truncated) +
      "；缓存 " +
      formatQualified(formatInteger(aggregate.tokens.cacheTokens), aggregate.truncated),
    "费用：" +
      formatQualified(
        "$" + (aggregate.costMicroCents / 100000000).toFixed(4),
        aggregate.truncated
      ),
    "模型排行：" + formatModels(aggregate.models, aggregate.truncated),
    "最近 24 小时每小时 Token：",
    ...renderInlineUsageChart(aggregate)
  ];
  if (aggregate.truncated) rows.push("图表仅含已采集的最新记录。");
  return rows;
}

export function renderThresholdMessage(
  snapshot: QuotaSnapshot,
  items: ThresholdItem[],
  eventId: string
): RenderedMessage {
  const highlights = new Map<WindowKey, Threshold>(
    items.map((item) => [item.window, item.threshold] as const)
  );
  const rows = WINDOW_KEYS.map((key) => {
    const value = snapshot.windows[key];
    const threshold = highlights.get(key);
    return (
      WINDOW_LABELS[key] +
      ": " +
      value.usedPercent +
      "%: " +
      (threshold === undefined ? "" : "达到 " + threshold + "%: ") +
      "重置 " +
      formatReset(value.resetAt)
    );
  });
  return {
    title: prefix(snapshot) + "OpenCode Go 用量提醒",
    content:
      prefix(snapshot) +
      rows.join("<br>") +
      "<br>数据时间：" +
      formatReset(snapshot.observedAt) +
      "<br>事件：" +
      eventId
  };
}

export function renderSummaryMessage(
  snapshot: QuotaSnapshot,
  eventId: string,
  delayed: boolean
): RenderedMessage {
  const rows = WINDOW_KEYS.map((key) => {
    const value = snapshot.windows[key];
    return (
      WINDOW_LABELS[key] +
      ": " +
      value.usedPercent +
      "%（重置 " +
      formatReset(value.resetAt) +
      "）"
    );
  });
  return {
    title: prefix(snapshot) + (delayed ? "OpenCode Go 延迟汇总" : "OpenCode Go 每日汇总"),
    content:
      prefix(snapshot) +
      rows.join("<br>") +
      "<br>数据时间：" +
      formatReset(snapshot.observedAt) +
      "<br>事件：" +
      eventId
  };
}

export function renderBroadcastMessage(
  snapshot: QuotaSnapshot,
  eventId: string,
  manual: boolean,
  usageDetails: UsageDetailsView = {
    status: "unavailable",
    reason: "not-authorized"
  }
): RenderedMessage {
  const quotaRows = WINDOW_KEYS.map((key) => {
    const value = snapshot.windows[key];
    return (
      WINDOW_LABELS[key] +
      ": " +
      value.usedPercent +
      "%（重置 " +
      formatReset(value.resetAt) +
      "）"
    );
  });
  const observedAt = formatReset(snapshot.observedAt);
  return {
    title: prefix(snapshot) +
      (manual ? "OpenCode Go 手动用量" : "OpenCode Go 整点用量"),
    content:
      prefix(snapshot) +
      quotaRows
        .concat(renderUsageDetails(usageDetails))
        .concat([
          "观察时间：" + observedAt,
          "当前小时为部分小时，仅统计至观察时间。",
          "事件：" + escapeHtmlText(eventId)
        ])
        .join("<br>")
  };
}

export function renderStartupMessage(
  snapshot: QuotaSnapshot,
  eventId: string
): RenderedMessage {
  return {
    ...renderSummaryMessage(snapshot, eventId, false),
    title: prefix(snapshot) + "OpenCode Go 监控已启动"
  };
}

export function renderFaultMessage(
  title: string,
  action: string,
  eventId: string
): RenderedMessage {
  return {
    title,
    content: action + "<br>事件：" + eventId
  };
}
