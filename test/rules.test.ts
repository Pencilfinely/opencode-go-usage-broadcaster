import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../src/domain";
import type { UsageAggregate, UsageHourBucket } from "../src/usage-domain";
import {
  evaluateSnapshot,
  renderBroadcastMessage,
  renderThresholdMessage
} from "../src/rules";

function snapshot(
  rolling: number,
  weekly: number,
  monthly: number,
  rollingResetAt = "2026-08-03T06:00:00.000Z",
  weeklyResetAt = "2026-08-03T06:00:00.000Z",
  monthlyResetAt = "2026-08-03T06:00:00.000Z"
): QuotaSnapshot {
  return {
    source: "fixture",
    observedAt: "2026-08-03T01:00:00.000Z",
    windows: {
      rolling: { status: "ok", usedPercent: rolling, resetAt: rollingResetAt },
      weekly: { status: "ok", usedPercent: weekly, resetAt: weeklyResetAt },
      monthly: { status: "ok", usedPercent: monthly, resetAt: monthlyResetAt }
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

function hourlyBuckets(): UsageHourBucket[] {
  const startAt = Date.UTC(2026, 7, 2, 16);
  return Array.from({ length: 24 }, (_, index) => ({
    startAt: startAt + index * 60 * 60 * 1000,
    inputTokens: index === 0 ? 40 : index === 1 ? 1 : 0,
    outputTokens: index === 0 ? 30 : 0,
    reasoningTokens: index === 0 ? 20 : 0,
    cacheTokens: index === 0 ? 10 : 0
  }));
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

  it("将可用的手动用量渲染为完整纯 HTML 仪表盘", () => {
    const message = renderBroadcastMessage(
      snapshot(
        49,
        20,
        10,
        "2026-08-03T06:00:00.000Z",
        "2026-08-09T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z"
      ),
      "manual:usage:2026-08-03T01:00:00.000Z",
      true,
      {
        status: "available",
        aggregate: aggregate({
          requestCount: 7,
          costMicroCents: 123456789,
          tokens: {
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 3,
            cacheTokens: 15,
            totalTokens: 48
          },
          buckets: hourlyBuckets(),
          models: [{ model: "模型一", tokenCount: 48, sharePercent: 100 }]
        })
      }
    );

    expect(message.title).toBe("【测试数据】OpenCode Go 手动用量");
    expect(message.content.match(/data-quota=/g)).toHaveLength(3);
    expect(message.content).toContain('data-dashboard-variant="rich"');
    expect(message.content.match(/data-hour-bar=/g)).toHaveLength(24);
    expect(message.content.match(/data-hour-value=/g)).toHaveLength(24);
    expect(message.content).toContain("观察时间：08/03 09:00");
    expect(message.content).toContain("manual:usage:2026-08-03T01:00:00.000Z");
    expect(message.content).not.toMatch(/[█░]/);
    expect(message.content).not.toMatch(/<(?:img|svg|canvas|script|style)\b/i);
    expect(message.content).not.toMatch(/\b(?:src|href)\s*=/i);
  });

  it("在明细不可用时保留额度和原因但隐藏可用专属区段", () => {
    const withoutAccess = renderBroadcastMessage(snapshot(49, 20, 10), "event-2", true);

    expect(withoutAccess.content.match(/data-quota=/g)).toHaveLength(3);
    expect(withoutAccess.content).toContain("24 小时明细尚未授权");
    expect(withoutAccess.content).not.toContain('data-section="summary"');
    expect(withoutAccess.content).not.toContain('data-section="hourly-chart"');
    expect(withoutAccess.content).not.toContain('data-section="token-breakdown"');
    expect(withoutAccess.content).not.toContain('data-section="hourly-exact"');
    expect(withoutAccess.content).not.toContain('data-section="models"');
  });
});
