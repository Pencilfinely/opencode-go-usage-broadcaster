import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../src/domain";
import type { UsageAggregate } from "../src/usage-domain";
import {
  evaluateSnapshot,
  renderBroadcastMessage,
  renderThresholdMessage
} from "../src/rules";

function snapshot(
  rolling: number,
  weekly: number,
  monthly: number,
  resetAt = "2026-08-03T06:00:00.000Z"
): QuotaSnapshot {
  return {
    source: "fixture",
    observedAt: "2026-08-03T01:00:00.000Z",
    windows: {
      rolling: { status: "ok", usedPercent: rolling, resetAt },
      weekly: { status: "ok", usedPercent: weekly, resetAt },
      monthly: { status: "ok", usedPercent: monthly, resetAt }
    }
  };
}

function aggregate(overrides: Partial<UsageAggregate> = {}): UsageAggregate {
  return {
    observedAt: Date.parse("2026-08-05T03:30:00.000Z"),
    windowStartAt: Date.parse("2026-08-04T04:00:00.000Z"),
    truncated: false,
    requestCount: 0,
    costMicroCents: 0,
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0
    },
    buckets: [],
    models: [],
    ...overrides
  };
}

describe("quota rules", () => {
  it("consumes all crossed thresholds and reports only the highest", () => {
    const baseline = evaluateSnapshot(
      null,
      snapshot(49, 20, 10),
      Date.parse("2026-08-03T01:00:00Z")
    );
    const jump = evaluateSnapshot(
      baseline.state,
      snapshot(92, 20, 10),
      Date.parse("2026-08-03T01:30:00Z")
    );
    const repeat = evaluateSnapshot(
      jump.state,
      snapshot(92, 20, 10),
      Date.parse("2026-08-03T02:00:00Z")
    );

    expect(jump.notifications).toEqual([
      expect.objectContaining({ window: "rolling", threshold: 90 })
    ]);
    expect(jump.consumptions.map((item) => item.threshold)).toEqual([
      50, 75, 90
    ]);
    expect(repeat.notifications).toHaveLength(0);
  });

  it("does not rearm before the boundary and rearms after a credible reset", () => {
    const first = evaluateSnapshot(
      null,
      snapshot(80, 20, 10, "2026-08-03T02:00:00.000Z"),
      Date.parse("2026-08-03T01:00:00Z")
    );
    const earlyDrop = evaluateSnapshot(
      first.state,
      snapshot(41, 20, 10, "2026-08-03T03:00:00.000Z"),
      Date.parse("2026-08-03T01:30:00Z")
    );
    const reset = evaluateSnapshot(
      earlyDrop.state,
      snapshot(40, 20, 10, "2026-08-03T07:00:00.000Z"),
      Date.parse("2026-08-03T02:01:00Z")
    );
    const crossedAgain = evaluateSnapshot(
      reset.state,
      snapshot(76, 20, 10, "2026-08-03T07:00:00.000Z"),
      Date.parse("2026-08-03T02:30:00Z")
    );

    expect(earlyDrop.state.windows.rolling.cycleKey).toBe(
      first.state.windows.rolling.cycleKey
    );
    expect(reset.state.windows.rolling.cycleKey).not.toBe(
      first.state.windows.rolling.cycleKey
    );
    expect(crossedAgain.notifications[0]?.threshold).toBe(75);
  });

  it("does not rearm when usage is unchanged after the boundary", () => {
    const first = evaluateSnapshot(
      null,
      snapshot(80, 20, 10, "2026-08-03T02:00:00.000Z"),
      Date.parse("2026-08-03T01:00:00Z")
    );
    const earlyDrop = evaluateSnapshot(
      first.state,
      snapshot(40, 20, 10, "2026-08-03T03:00:00.000Z"),
      Date.parse("2026-08-03T01:30:00Z")
    );
    const unchangedAfterBoundary = evaluateSnapshot(
      earlyDrop.state,
      snapshot(40, 20, 10, "2026-08-03T07:00:00.000Z"),
      Date.parse("2026-08-03T02:01:00Z")
    );

    expect(unchangedAfterBoundary.state.windows.rolling.cycleKey).toBe(
      first.state.windows.rolling.cycleKey
    );
  });

  it("visibly marks fixture threshold messages with all windows and the stable event ID", () => {
    const message = renderThresholdMessage(
      snapshot(92, 20, 10),
      [
        {
          window: "rolling",
          cycleKey: "reset:2026-08-03T06:00:00.000Z",
          threshold: 90,
          usedPercent: 92,
          resetAt: "2026-08-03T06:00:00.000Z"
        }
      ],
      "threshold:rolling:reset:2026-08-03T06:00:00.000Z:90"
    );

    expect(message.title).toContain("【测试数据】");
    expect(message.content).toContain("5 小时额度: 92%: 达到 90%");
    expect(message.content).toContain("每周额度: 20%");
    expect(message.content).toContain("每月额度: 10%");
    expect(message.content).not.toContain("达到 50%");
    expect(message.content).not.toContain("达到 75%");
    expect(message.content).toContain(
      "threshold:rolling:reset:2026-08-03T06:00:00.000Z:90"
    );
  });

  it("转义模型名并以至少标识截断汇总", () => {
    const message = renderBroadcastMessage(snapshot(49, 20, 10), "event-1", false, {
      status: "available",
      aggregate: aggregate({
        truncated: true,
        requestCount: 7,
        costMicroCents: 123456789,
        tokens: {
          inputTokens: 10,
          outputTokens: 20,
          reasoningTokens: 3,
          cacheTokens: 15,
          totalTokens: 48
        },
        models: [{ model: "<img src=x>", tokenCount: 48, sharePercent: 100 }]
      })
    });

    expect(message.content).toContain("&lt;img src=x&gt;");
    expect(message.content).not.toContain("<img src=x>");
    expect(message.content).toContain("至少 7");
    expect(message.content).toContain("至少 48");
    expect(message.content).toContain("至少 $1.2346");
    expect(message.content).toContain("仅含已采集的最新记录");
  });

  it("在文字汇总降级时保留零值且只渲染一个安全图表", () => {
    const withoutAccess = renderBroadcastMessage(snapshot(49, 20, 10), "event-2", true);
    const withChart = renderBroadcastMessage(snapshot(49, 20, 10), "event-3", true, {
      status: "available",
      aggregate: aggregate(),
      chartUrl: "https://example.test/chart.svg?a=1&b=2"
    });

    expect(withoutAccess.content).toContain("24 小时明细尚未授权");
    expect(withoutAccess.content).not.toContain("<img");
    expect(withChart.content).toContain("请求数：0");
    expect(withChart.content).toContain("总 Token：0");
    expect(withChart.content.match(/<img /g)).toHaveLength(1);
    expect(withChart.content).toContain("a=1&amp;b=2");
  });
});
