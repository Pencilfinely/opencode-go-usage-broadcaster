import {
  createExecutionContext,
  createScheduledController
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/app";
import { SourceError, type QuotaSnapshot, type QuotaSource } from "../src/domain";

const AT_0900 = Date.parse("2026-08-03T01:00:00.000Z");
const AT_0907 = Date.parse("2026-08-03T01:07:00.000Z");

function snapshot(percent: number, observedAt: number): QuotaSnapshot {
  const resetAt = new Date(observedAt + 5 * 60 * 60 * 1000).toISOString();
  return {
    source: "fixture",
    observedAt: new Date(observedAt).toISOString(),
    windows: {
      rolling: { status: "ok", usedPercent: percent, resetAt },
      weekly: { status: "ok", usedPercent: percent, resetAt },
      monthly: { status: "ok", usedPercent: percent, resetAt }
    }
  };
}

function testEnv(): Cloudflare.Env {
  return {
    ...env,
    USAGE_SOURCE: "fixture",
    USAGE_FIXTURE_JSON: "{}",
    OPENCODE_CONSOLE_ENABLED: "false",
    OPENCODE_AUTH_GENERATION: "generation-1",
    PUSHPLUS_TOKEN: "test-token",
    PUSHPLUS_TOPIC: "test-topic",
    PUSHPLUS_CALLBACK_SECRET: "12345678901234567890123456789012",
    PUSHPLUS_CALLBACK_BASE_URL: "https://worker.example.test"
  } as unknown as Cloudflare.Env;
}

describe("scheduled orchestration", () => {
  it("coalesces threshold crossings and the 09:07 daily summary", async () => {
    const source: QuotaSource = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(snapshot(49, AT_0900))
        .mockResolvedValueOnce(snapshot(76, AT_0907))
    };
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0900),
        cron: "*/30 * * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source, fetchImpl: pushFetch, now: () => AT_0900 }
    );
    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0907),
        cron: "7 1 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source, fetchImpl: pushFetch, now: () => AT_0907 }
    );

    const rows = await env.DB.prepare(
      "SELECT kind, logical_key, content FROM outbox_events"
    ).all<{ kind: string; logical_key: string; content: string }>();
    expect(rows.results.map((row) => row.kind).sort()).toEqual([
      "daily",
      "startup",
      "threshold"
    ]);
    const threshold = rows.results.find((row) => row.kind === "threshold");
    expect(threshold?.content).toContain("75%");
    expect(threshold?.content).not.toContain("达到 50%");
    expect(rows.results.every((row) => row.content.includes("【测试数据】")))
      .toBe(true);
  });

  it("does not retry auth until the generation changes", async () => {
    const sourceFetch = vi
      .fn()
      .mockRejectedValueOnce(new SourceError("auth", "expired"))
      .mockResolvedValueOnce(snapshot(20, AT_0907));
    const source: QuotaSource = { fetch: sourceFetch };
    const base = testEnv();
    const run = async (at: number, authGeneration: string) =>
      runScheduled(
        createScheduledController({
          scheduledTime: new Date(at),
          cron: "*/30 * * * *"
        }),
        {
          ...base,
          OPENCODE_AUTH_GENERATION: authGeneration
        } as unknown as Cloudflare.Env,
        createExecutionContext(),
        {
          source,
          now: () => at,
          fetchImpl: vi.fn().mockResolvedValue(
            Response.json({ code: 200, data: "provider-id" })
          )
        }
      );

    await run(AT_0900, "generation-1");
    await run(AT_0900 + 30 * 60 * 1000, "generation-1");
    expect(sourceFetch).toHaveBeenCalledTimes(1);

    await run(AT_0907 + 30 * 60 * 1000, "generation-2");
    expect(sourceFetch).toHaveBeenCalledTimes(2);
  });
});
