import { describe, expect, it } from "vitest";
import { aggregateUsage24h } from "../src/usage-aggregate";
import type { UsageRecord } from "../src/usage-domain";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "use_base",
    occurredAt: Date.parse("2026-08-05T03:00:00.000Z"),
    provider: "anthropic",
    model: "claude-sonnet",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    costMicroCents: 0,
    ...overrides
  };
}

describe("二十四小时用量聚合", () => {
  it("生成二十四个北京时间小时桶并排除窗口外记录", () => {
    const aggregate = aggregateUsage24h([
      usage({
        id: "boundary",
        occurredAt: Date.parse("2026-08-04T04:00:00.000Z"),
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWrite5mTokens: 5,
        cacheWrite1hTokens: 6,
        costMicroCents: 100000000
      }),
      usage({
        id: "before",
        occurredAt: Date.parse("2026-08-04T03:59:59.999Z"),
        inputTokens: 99
      }),
      usage({
        id: "future",
        occurredAt: Date.parse("2026-08-05T03:30:00.001Z"),
        inputTokens: 99
      })
    ], Date.parse("2026-08-05T03:30:00.000Z"), false);

    expect(aggregate.buckets).toHaveLength(24);
    expect(aggregate.windowStartAt).toBe(Date.parse("2026-08-04T04:00:00.000Z"));
    expect(aggregate.buckets[0]).toMatchObject({
      startAt: Date.parse("2026-08-04T04:00:00.000Z"),
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheTokens: 15
    });
    expect(aggregate.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheTokens: 15,
      totalTokens: 48
    });
    expect(aggregate.costMicroCents).toBe(100000000);
    expect(aggregate.requestCount).toBe(1);
  });

  it("按稳定规则保留前五模型并将其余合并为其他", () => {
    const aggregate = aggregateUsage24h([
      usage({ id: "a", model: "zeta", inputTokens: 2 }),
      usage({ id: "b", model: "alpha", inputTokens: 2 }),
      usage({ id: "c", model: "beta", inputTokens: 2 }),
      usage({ id: "d", model: "delta", inputTokens: 2 }),
      usage({ id: "e", model: "epsilon", inputTokens: 2 }),
      usage({ id: "f", model: "gamma", inputTokens: 2 }),
      usage({ id: "g", model: "eta", inputTokens: 1 })
    ], Date.parse("2026-08-05T03:30:00.000Z"), true);

    expect(aggregate.models).toEqual([
      { model: "alpha", tokenCount: 2, sharePercent: 15.384615384615385 },
      { model: "beta", tokenCount: 2, sharePercent: 15.384615384615385 },
      { model: "delta", tokenCount: 2, sharePercent: 15.384615384615385 },
      { model: "epsilon", tokenCount: 2, sharePercent: 15.384615384615385 },
      { model: "gamma", tokenCount: 2, sharePercent: 15.384615384615385 },
      { model: "其他", tokenCount: 3, sharePercent: 23.076923076923077 }
    ]);
  });

  it("拒绝无效观察时间和不安全记录数值", () => {
    expect(() => aggregateUsage24h([], Number.NaN, false)).toThrow();
    expect(() => aggregateUsage24h([
      usage({ inputTokens: Number.MAX_SAFE_INTEGER + 1 })
    ], Date.parse("2026-08-05T03:30:00.000Z"), false)).toThrow();
  });
});
