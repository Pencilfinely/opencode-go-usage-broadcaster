import {
  WINDOW_KEYS,
  type QuotaSnapshot,
  type UsageWindow,
  type WindowKey
} from "./domain";
import { renderUsageDashboardHtml } from "./usage-dashboard-html";
import type { UsageDetailsView } from "./usage-domain";

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
  const quotaRows = WINDOW_KEYS.map((key) => ({
    key,
    label: WINDOW_LABELS[key],
    usedPercent: snapshot.windows[key].usedPercent,
    resetText: formatReset(snapshot.windows[key].resetAt)
  }));
  const statusLabel = manual ? "手动用量" : "整点用量";

  return {
    title: prefix(snapshot) + "OpenCode Go " + statusLabel,
    content: renderUsageDashboardHtml({
      testData: snapshot.source === "fixture",
      statusLabel,
      observedAtText: formatReset(snapshot.observedAt),
      quotaRows,
      usageDetails,
      eventId
    })
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
