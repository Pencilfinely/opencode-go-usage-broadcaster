import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../src/domain";
import { evaluateSnapshot, renderThresholdMessage } from "../src/rules";

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
      snapshot(40, 20, 10, "2026-08-03T03:00:00.000Z"),
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
});
