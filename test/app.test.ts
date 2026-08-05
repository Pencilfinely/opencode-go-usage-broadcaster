import {
  createExecutionContext,
  createScheduledController
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isShanghaiBroadcastSlot,
  runBroadcast,
  runScheduled
} from "../src/app";
import { SourceError, type QuotaSnapshot, type QuotaSource } from "../src/domain";

const AT_0900 = Date.parse("2026-08-03T01:00:00.000Z");
const AT_1000 = Date.parse("2026-08-03T02:00:00.000Z");

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
    PUSHPLUS_CALLBACK_BASE_URL: "https://worker.example.test",
    MANUAL_TRIGGER_SECRET: "test-manual-trigger-secret-32-bytes-minimum"
  } as unknown as Cloudflare.Env;
}

describe("定时广播编排", () => {
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

  it.each([
    ["2026-08-05T00:59:00Z", false],
    ["2026-08-05T01:00:00Z", true],
    ["2026-08-05T15:00:00Z", true],
    ["2026-08-05T16:00:00Z", false]
  ])("仅在北京时间 09:00 至 23:00 的整点广播：%s", (timestamp, expected) => {
    expect(isShanghaiBroadcastSlot(Date.parse(timestamp))).toBe(expected);
  });

  it("每个北京时间整点创建独立汇总并对同一整点去重", async () => {
    const at0900 = Date.parse("2026-08-05T01:00:00Z");
    const at1000 = Date.parse("2026-08-05T02:00:00Z");
    const sourceFetch = vi
      .fn()
      .mockResolvedValueOnce(snapshot(20, at0900))
      .mockResolvedValueOnce(snapshot(21, at1000));
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );
    const run = (scheduledAt: number) => runScheduled(
      createScheduledController({
        scheduledTime: new Date(scheduledAt),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      {
        source: { fetch: sourceFetch },
        fetchImpl: pushFetch,
        now: () => scheduledAt
      }
    );

    await run(at0900);
    await run(at1000);
    await run(at1000);

    const events = await env.DB.prepare(
      "SELECT kind, logical_key FROM outbox_events ORDER BY logical_key"
    ).all<{ kind: string; logical_key: string }>();
    expect(events.results).toEqual([
      {
        kind: "daily",
        logical_key: "broadcast:scheduled:2026-08-05:09"
      },
      {
        kind: "daily",
        logical_key: "broadcast:scheduled:2026-08-05:10"
      }
    ]);
    expect(sourceFetch).toHaveBeenCalledTimes(2);
  });

  it("静默时段在采集和投递前返回", async () => {
    const sourceFetch = vi.fn().mockResolvedValue(snapshot(20, AT_0900));
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date("2026-08-05T00:59:00Z"),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source: { fetch: sourceFetch }, fetchImpl: pushFetch }
    );

    expect(sourceFetch).not.toHaveBeenCalled();
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it("手动广播用摘要标识去重并使用手动标题", async () => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const sourceFetch = vi.fn().mockResolvedValue(snapshot(20, occurredAt));
    const deps = {
      source: { fetch: sourceFetch },
      fetchImpl: vi.fn().mockResolvedValue(
        Response.json({ code: 200, data: "provider-id" })
      ),
      now: () => occurredAt
    };
    const trigger = {
      type: "manual" as const,
      occurredAt,
      idempotencyDigest: "digest-1"
    };

    expect(await runBroadcast(trigger, testEnv(), deps)).toBe("completed");
    expect(await runBroadcast(trigger, testEnv(), deps)).toBe("duplicate");

    const event = await env.DB.prepare(
      "SELECT logical_key, kind, title FROM outbox_events"
    ).first<{ logical_key: string; kind: string; title: string }>();
    expect(event).toEqual({
      logical_key: "broadcast:manual:digest-1",
      kind: "daily",
      title: "【测试数据】OpenCode Go 手动用量"
    });
    expect(sourceFetch).toHaveBeenCalledTimes(1);
  });

  it("手动广播先执行时不取消延迟到达的定时整点", async () => {
    const scheduledAt = Date.parse("2026-08-05T02:00:00Z");
    const manualAt = Date.parse("2026-08-05T02:30:00Z");
    const delayedNow = Date.parse("2026-08-05T02:31:00Z");
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    await runBroadcast(
      { type: "manual", occurredAt: manualAt, idempotencyDigest: "manual-first" },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, manualAt)) },
        fetchImpl: pushFetch,
        now: () => manualAt
      }
    );
    await runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(21, delayedNow)) },
        fetchImpl: pushFetch,
        now: () => delayedNow
      }
    );

    const events = await env.DB.prepare(
      "SELECT logical_key FROM outbox_events ORDER BY logical_key"
    ).all<{ logical_key: string }>();
    expect(events.results.map((event) => event.logical_key)).toEqual([
      "broadcast:manual:manual-first",
      "broadcast:scheduled:2026-08-05:10"
    ]);
    const runtime = await env.DB.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'runtime'"
    ).first<{ value_json: string }>();
    expect(JSON.parse(runtime!.value_json).version).toBe(scheduledAt);
  });

  it("定时整点先执行时不取消同刻之前发生的手动广播", async () => {
    const scheduledAt = Date.parse("2026-08-05T02:00:00Z");
    const manualAt = Date.parse("2026-08-05T01:30:00Z");
    const manualNow = Date.parse("2026-08-05T02:01:00Z");
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    await runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, scheduledAt)) },
        fetchImpl: pushFetch,
        now: () => scheduledAt
      }
    );
    await runBroadcast(
      { type: "manual", occurredAt: manualAt, idempotencyDigest: "scheduled-first" },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(21, manualNow)) },
        fetchImpl: pushFetch,
        now: () => manualNow
      }
    );

    const events = await env.DB.prepare(
      "SELECT logical_key FROM outbox_events ORDER BY logical_key"
    ).all<{ logical_key: string }>();
    expect(events.results.map((event) => event.logical_key)).toEqual([
      "broadcast:manual:scheduled-first",
      "broadcast:scheduled:2026-08-05:10"
    ]);
    const states = await env.DB.prepare(
      "SELECT key, value_json FROM runtime_state ORDER BY key"
    ).all<{ key: string; value_json: string }>();
    const quota = JSON.parse(
      states.results.find((state) => state.key === "quota")!.value_json
    );
    const runtime = JSON.parse(
      states.results.find((state) => state.key === "runtime")!.value_json
    );
    expect(quota.windows.rolling.usedPercent).toBe(21);
    expect(runtime.version).toBe(scheduledAt);
  });

  it("阈值跨越只更新额度状态且每个整点仍生成汇总", async () => {
    const source: QuotaSource = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(snapshot(49, AT_0900))
        .mockResolvedValueOnce(snapshot(76, AT_1000))
    };
    const pushFetch = vi.fn().mockImplementation(() => Promise.resolve(
      Response.json({ code: 200, data: "provider-id" })
    ));

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0900),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source, fetchImpl: pushFetch, now: () => AT_0900 }
    );
    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_1000),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source, fetchImpl: pushFetch, now: () => AT_1000 }
    );

    const rows = await env.DB.prepare(
      "SELECT id, kind, logical_key, content FROM outbox_events"
    ).all<{
      id: string;
      kind: string;
      logical_key: string;
      content: string;
    }>();
    expect(rows.results.map((row) => row.kind)).toEqual(["daily", "daily"]);
    expect(rows.results.every((row) => row.content.includes("【测试数据】")))
      .toBe(true);
    const triggers = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_triggers"
    ).first<{ count: number }>();
    expect(triggers?.count).toBe(0);
    const quota = await env.DB.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'quota'"
    ).first<{ value_json: string }>();
    expect(JSON.parse(quota!.value_json).windows.rolling.consumed)
      .toEqual([50, 75]);
  });

  it("鉴权世代变化前不重试采集", async () => {
    const sourceFetch = vi
      .fn()
      .mockRejectedValueOnce(new SourceError("auth", "expired"))
      .mockResolvedValueOnce(snapshot(20, AT_1000));
    const source: QuotaSource = { fetch: sourceFetch };
    const base = testEnv();
    const run = async (at: number, authGeneration: string) =>
      runScheduled(
        createScheduledController({
          scheduledTime: new Date(at),
          cron: "0 1-15 * * *"
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
    await run(AT_0900 + 60 * 60 * 1000, "generation-1");
    expect(sourceFetch).toHaveBeenCalledTimes(1);

    await run(AT_0900 + 2 * 60 * 60 * 1000, "generation-2");
    expect(sourceFetch).toHaveBeenCalledTimes(2);
  });

  it("运行时状态无法加载时终结已启动任务", async () => {
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
        cron: "0 1-15 * * *"
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
    ).bind("broadcast:scheduled:2026-08-03:09").first<{
      status: string;
      error_kind: string | null;
    }>();
    expect(job).toEqual({ status: "failed", error_kind: "internal" });
  });

  it("将非对象快照归类为结构故障", async () => {
    const source: QuotaSource = {
      fetch: vi.fn().mockResolvedValue(undefined as unknown as QuotaSnapshot)
    };

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(AT_0900),
        cron: "0 1-15 * * *"
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
    ).bind("broadcast:scheduled:2026-08-03:09").first()).toEqual({
      status: "failed",
      error_kind: "schema"
    });
  });

  it("将未知窗口状态归类为结构故障", async () => {
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
        cron: "0 1-15 * * *"
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
    ).bind("broadcast:scheduled:2026-08-03:09").first()).toEqual({
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
        cron: "0 1-15 * * *"
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

    for (const scheduledTime of [AT_1000, AT_0900 + 2 * 60 * 60 * 1000]) {
      await runScheduled(
        createScheduledController({
          scheduledTime: new Date(scheduledTime),
          cron: "0 1-15 * * *"
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
