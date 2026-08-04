import {
  createExecutionContext,
  createScheduledController
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_triggers"),
      env.DB.prepare("DELETE FROM outbox_attempts"),
      env.DB.prepare("DELETE FROM outbox_events"),
      env.DB.prepare("DELETE FROM runtime_state"),
      env.DB.prepare("DELETE FROM job_runs"),
      env.DB.prepare(
        "UPDATE locks SET owner = NULL, lease_until = 0 " +
        "WHERE name = 'snapshot'"
      )
    ]);
  });

  it("coalesces threshold crossings and the 09:07 daily summary", async () => {
    const source: QuotaSource = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(snapshot(49, AT_0900))
        .mockResolvedValueOnce(snapshot(76, AT_0907))
    };
    const pushFetch = vi.fn().mockImplementation(() => Promise.resolve(
      Response.json({ code: 200, data: "provider-id" })
    ));

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
      "SELECT id, kind, logical_key, content FROM outbox_events"
    ).all<{
      id: string;
      kind: string;
      logical_key: string;
      content: string;
    }>();
    expect(rows.results.map((row) => row.kind).sort()).toEqual([
      "daily",
      "startup",
      "threshold"
    ]);
    const threshold = rows.results.find((row) => row.kind === "threshold");
    expect(threshold?.content.match(/达到 75%/gu)).toHaveLength(3);
    expect(threshold?.content).not.toContain("达到 50%");
    expect(rows.results.every((row) => row.content.includes("【测试数据】")))
      .toBe(true);
    const triggers = await env.DB.prepare(
      "SELECT threshold FROM event_triggers WHERE event_id = ? " +
      "ORDER BY threshold, window_key"
    ).bind(threshold!.id).all<{ threshold: number }>();
    expect(triggers.results.map((trigger) => trigger.threshold)).toEqual([
      50, 50, 50, 75, 75, 75
    ]);
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
          fetchImpl: vi.fn().mockImplementation(() => Promise.resolve(
            Response.json({ code: 200, data: "provider-id" })
          ))
        }
      );

    await run(AT_0900, "generation-1");
    await run(AT_0900 + 30 * 60 * 1000, "generation-1");
    expect(sourceFetch).toHaveBeenCalledTimes(1);

    await run(AT_0907 + 30 * 60 * 1000, "generation-2");
    expect(sourceFetch).toHaveBeenCalledTimes(2);
  });

  it("finalizes a started job when runtime state cannot be loaded", async () => {
    await env.DB.prepare(
      "INSERT INTO runtime_state (key, value_json, version, updated_at) " +
      "VALUES ('runtime', ?, 0, ?)"
    ).bind('{"secret":"must-not-be-stored"', AT_0900 - 1).run();
    const source: QuotaSource = {
      fetch: vi.fn().mockResolvedValue(snapshot(20, AT_0900))
    };

    await expect(runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0900),
        cron: "*/30 * * * *"
      }),
      testEnv(),
      createExecutionContext(),
      {
        source,
        now: () => AT_0900,
        fetchImpl: vi.fn().mockImplementation(() => Promise.resolve(
          Response.json({ code: 200, data: "provider-id" })
        ))
      }
    )).rejects.toBeInstanceOf(SyntaxError);

    const job = await env.DB.prepare(
      "SELECT status, error_kind FROM job_runs WHERE job_key = ?"
    ).bind("regular:" + AT_0900).first<{
      status: string;
      error_kind: string | null;
    }>();
    expect(job).toEqual({ status: "failed", error_kind: "internal" });
  });

  it("classifies a non-object injected snapshot as a schema failure", async () => {
    const source: QuotaSource = {
      fetch: vi.fn().mockResolvedValue(undefined as unknown as QuotaSnapshot)
    };

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0900),
        cron: "*/30 * * * *"
      }),
      testEnv(),
      createExecutionContext(),
      {
        source,
        now: () => AT_0900,
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({ code: 200, data: "provider-id" })
        )
      }
    );

    expect(await env.DB.prepare(
      "SELECT status, error_kind FROM job_runs WHERE job_key = ?"
    ).bind("regular:" + AT_0900).first()).toEqual({
      status: "failed",
      error_kind: "schema"
    });
  });

  it("classifies an unknown window status as a schema failure", async () => {
    const malformed = snapshot(20, AT_0900) as unknown as {
      windows: { rolling: { status: string } };
    };
    malformed.windows.rolling.status = "unexpected";
    const source: QuotaSource = {
      fetch: vi.fn().mockResolvedValue(malformed as unknown as QuotaSnapshot)
    };

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0900),
        cron: "*/30 * * * *"
      }),
      testEnv(),
      createExecutionContext(),
      {
        source,
        now: () => AT_0900,
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({ code: 200, data: "provider-id" })
        )
      }
    );

    expect(await env.DB.prepare(
      "SELECT status, error_kind FROM job_runs WHERE job_key = ?"
    ).bind("regular:" + AT_0900).first()).toEqual({
      status: "failed",
      error_kind: "schema"
    });
  });

  it("损坏的会话 Secret 连续失败时保留已有 quota 且只创建一次结构故障", async () => {
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
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(42, AT_0900)) },
        now: () => AT_0900,
        fetchImpl: pushFetch
      }
    );
    const quotaBefore = await env.DB.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'quota'"
    ).first<{ value_json: string }>();
    const damagedSecret = '{"auth":{"cookie":"auth=不得写入状态"}}';
    const sourceFetch = vi.fn();
    const damagedEnv = {
      ...testEnv(),
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "true",
      OPENCODE_SESSION_BUNDLE: damagedSecret,
      OPENCODE_AUTH_GENERATION: undefined
    } as unknown as Cloudflare.Env;

    for (const scheduledTime of [AT_0900 + 30 * 60 * 1000, AT_0900 + 60 * 60 * 1000]) {
      await runScheduled(
        createScheduledController({
          scheduledTime: new Date(scheduledTime),
          cron: "*/30 * * * *"
        }),
        damagedEnv,
        createExecutionContext(),
        {
          now: () => scheduledTime,
          fetchImpl: pushFetch,
          sourceFetchImpl: sourceFetch
        }
      );
    }

    const quotaAfter = await env.DB.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'quota'"
    ).first<{ value_json: string }>();
    const faults = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE kind = 'fault'"
    ).first<{ count: number }>();
    const runtime = await env.DB.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'runtime'"
    ).first<{ value_json: string }>();
    expect(quotaAfter).toEqual(quotaBefore);
    expect(faults?.count).toBe(1);
    expect(runtime?.value_json).not.toContain("不得写入状态");
    expect(sourceFetch).not.toHaveBeenCalled();
  });
});
