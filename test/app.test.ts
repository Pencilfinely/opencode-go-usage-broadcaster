import {
  createExecutionContext,
  createScheduledController
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isShanghaiBroadcastSlot,
  runBroadcast,
  runScheduled
} from "../src/app";
import { SourceError, type QuotaSnapshot, type QuotaSource } from "../src/domain";
import {
  LeaseLostError,
  Repository
} from "../src/repository";
import type { UsageRecord } from "../src/usage-domain";

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

function usageRecord(
  id: string,
  occurredAt: number,
  model = "gpt-5"
): UsageRecord {
  return {
    id,
    occurredAt,
    provider: "openai",
    model,
    plan: "sub",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 25,
    cacheReadTokens: 10,
    cacheWrite5mTokens: 5,
    cacheWrite1hTokens: 0,
    costMicroCents: 1234
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("定时广播编排", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_triggers"),
      env.DB.prepare("DELETE FROM outbox_attempts"),
      env.DB.prepare("DELETE FROM usage_chart_snapshots"),
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

  it("定时额度与完整明细成功时直接固化内嵌图表", async () => {
    const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
    const usageSourceFetch = vi.fn().mockResolvedValue({
      status: "complete" as const,
      records: [
        usageRecord("usage-1", scheduledAt - 60_000, "gpt-5"),
        usageRecord("usage-2", scheduledAt - 120_000, "claude-sonnet")
      ],
      pagesRead: 1
    });

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(scheduledAt),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, scheduledAt)) },
        usageSource: { fetch: usageSourceFetch },
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({ code: 200, data: "provider-id" })
        ),
        now: () => scheduledAt
      }
    );

    const event = await env.DB.prepare(
      "SELECT id, content, status FROM outbox_events WHERE kind = 'daily'"
    ).first<{ id: string; content: string; status: string }>();
    expect(event?.status).toBe("succeeded");
    expect(event?.content).toContain('data-dashboard-variant="rich"');
    expect(event?.content).toContain('data-section="summary"');
    expect(event?.content).toContain("<strong>380</strong>");
    expect(event?.content).toContain('data-section="models"');
    expect(event?.content).toContain("gpt-5");
    expect(event?.content.match(/data-hour-value=/g)).toHaveLength(24);
    expect(event?.content).not.toContain("<img");
    expect(event?.content).not.toMatch(/[█░]/);
    expect(event?.content).not.toContain("图表暂不可用");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM usage_chart_snapshots"
    ).first()).toEqual({ count: 0 });
    expect(usageSourceFetch).toHaveBeenCalledWith(scheduledAt);
  });

  it("提交前续租失败时不提交或投递", async () => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const renew = vi.spyOn(Repository.prototype, "renewSnapshotLease")
      .mockResolvedValue(false);
    const commit = vi.spyOn(Repository.prototype, "commitSnapshotUnderLease");
    const pushFetch = vi.fn();

    await expect(runBroadcast(
      {
        type: "manual",
        occurredAt,
        idempotencyDigest: "renew-before-publish-lost"
      },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, occurredAt)) },
        usageSource: {
          fetch: vi.fn().mockResolvedValue({
            status: "complete",
            records: [],
            pagesRead: 1
          })
        },
        fetchImpl: pushFetch,
        now: () => occurredAt
      }
    )).rejects.toBeInstanceOf(LeaseLostError);

    expect(renew).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it("明细不可用时提交前续租失败不提交或投递", async () => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const renew = vi.spyOn(Repository.prototype, "renewSnapshotLease")
      .mockResolvedValue(false);
    const commit = vi.spyOn(Repository.prototype, "commitSnapshotUnderLease");
    const pushFetch = vi.fn();

    await expect(runBroadcast(
      {
        type: "manual",
        occurredAt,
        idempotencyDigest: "renew-unavailable-lost"
      },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, occurredAt)) },
        usageSource: {
          fetch: vi.fn().mockResolvedValue({
            status: "unavailable",
            reason: "not-authorized"
          })
        },
        fetchImpl: pushFetch,
        now: () => occurredAt
      }
    )).rejects.toBeInstanceOf(LeaseLostError);

    expect(renew).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it("同一手动幂等键只创建并投递一个 daily 事件", async () => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const usageSourceFetch = vi.fn().mockResolvedValue({
      status: "complete" as const,
      records: [usageRecord("manual-usage", occurredAt - 60_000)],
      pagesRead: 1
    });
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );
    const trigger = {
      type: "manual" as const,
      occurredAt,
      idempotencyDigest: "usage-details-idempotency"
    };
    const deps = {
      source: { fetch: vi.fn().mockResolvedValue(snapshot(20, occurredAt)) },
      usageSource: { fetch: usageSourceFetch },
      fetchImpl: pushFetch,
      now: () => occurredAt
    };

    expect(await runBroadcast(trigger, testEnv(), deps)).toBe("completed");
    expect(await runBroadcast(trigger, testEnv(), deps)).toBe("duplicate");

    const event = await env.DB.prepare(
      "SELECT id, content FROM outbox_events WHERE logical_key = ?"
    ).bind("broadcast:manual:usage-details-idempotency").first<{
      id: string;
      content: string;
    }>();
    expect(event?.content).toContain('data-dashboard-variant="rich"');
    expect(event?.content).toContain('data-section="hourly-exact"');
    expect(event?.content.match(/data-hour-value=/g)).toHaveLength(24);
    expect(event?.content).not.toContain("<img");
    expect(event?.content).not.toMatch(/[█░]/);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE kind = 'daily'"
    ).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM usage_chart_snapshots"
    ).first()).toEqual({ count: 0 });
    expect(usageSourceFetch).toHaveBeenCalledOnce();
    expect(pushFetch).toHaveBeenCalledOnce();
  });

  it.each(["auth", "transient", "schema"] as const)(
    "明细来源抛出 %s 时仅降级文字且不污染额度故障状态",
    async (kind) => {
      const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
      const usageSourceFetch = vi.fn().mockRejectedValue(
        new SourceError(kind, "明细失败")
      );
      const expectedCopy = {
        auth: "24 小时明细登录已失效",
        transient: "24 小时明细暂时不可用",
        schema: "24 小时明细格式已变化"
      }[kind];

      expect(await runBroadcast(
        { type: "scheduled", occurredAt: scheduledAt },
        testEnv(),
        {
          source: {
            fetch: vi.fn().mockResolvedValue(snapshot(20, scheduledAt))
          },
          usageSource: {
            fetch: usageSourceFetch
          },
          fetchImpl: vi.fn().mockResolvedValue(
            Response.json({ code: 200, data: "provider-id" })
          ),
          now: () => scheduledAt
        }
      )).toBe("completed");

      const event = await env.DB.prepare(
        "SELECT content FROM outbox_events WHERE kind = 'daily'"
      ).first<{ content: string }>();
      expect(event?.content).toContain("5 小时额度");
      expect(event?.content).toContain("每周额度");
      expect(event?.content).toContain("每月额度");
      expect(event?.content).toContain(expectedCopy);
      expect(event?.content).not.toContain("<img");
      expect(event?.content).not.toContain("最近 24 小时每小时 Token");
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM usage_chart_snapshots"
      ).first()).toEqual({ count: 0 });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE kind = 'fault'"
      ).first()).toEqual({ count: 0 });
      const runtime = await env.DB.prepare(
        "SELECT value_json FROM runtime_state WHERE key = 'runtime'"
      ).first<{ value_json: string }>();
      expect(JSON.parse(runtime!.value_json).faults.auth).toBeUndefined();
      expect(usageSourceFetch).toHaveBeenCalledWith(scheduledAt);
    }
  );

  it("合法空明细显示零汇总和内嵌图表", async () => {
    const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
    expect(await runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, scheduledAt)) },
        usageSource: {
          fetch: vi.fn().mockResolvedValue({
            status: "complete",
            records: [],
            pagesRead: 1
          })
        },
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({ code: 200, data: "provider-id" })
        ),
        now: () => scheduledAt
      }
    )).toBe("completed");

    const event = await env.DB.prepare(
      "SELECT id, content FROM outbox_events WHERE kind = 'daily'"
    ).first<{ id: string; content: string }>();
    expect(event?.content).toContain('data-section="summary"');
    expect(event?.content).toContain("最近 24 小时请求数<br><strong>0</strong>");
    expect(event?.content).toContain("总 Token<br><strong>0</strong>");
    expect(event?.content).toContain("暂无模型记录");
    expect(event).not.toBeNull();
    expect(event?.content.match(/data-hour-row="\d{2}"/g))
      .toHaveLength(24);
    expect(event?.content.match(/data-mini-bar-row="\d{2}"/g))
      .toHaveLength(24);
    expect(event?.content).toContain('data-hour-layout="single"');
    expect(event?.content).toMatch(
      /data-hour-meta="\d{2}"[\s\S]*?<td width="70%" align="right"[^>]*white-space:normal[^>]*>0<\/td>/
    );
    expect(event?.content).not.toMatch(/align="right"[^>]*nowrap>0<\/td>/);
    expect(event?.content).not.toContain("<img");
    expect(event?.content).not.toMatch(/[█░]/);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM usage_chart_snapshots"
    ).first()).toEqual({ count: 0 });
  });

  it("明细采集跨过定时槽位边界时跳过旧整点且不创建事件或快照", async () => {
    const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
    const slotEnd = Date.parse("2026-08-05T02:00:00Z");
    let current = slotEnd - 10_000;
    const usageSourceFetch = vi.fn(async () => {
      current = slotEnd;
      return { status: "complete" as const, records: [], pagesRead: 1 };
    });

    expect(await runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, scheduledAt)) },
        usageSource: { fetch: usageSourceFetch },
        fetchImpl: vi.fn(),
        now: () => current
      }
    )).toBe("completed");

    expect(usageSourceFetch).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(
      "SELECT status, error_kind FROM job_runs WHERE job_key = ?"
    ).bind("broadcast:scheduled:2026-08-05:09").first()).toEqual({
      status: "skipped",
      error_kind: "expired-slot"
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events"
    ).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM usage_chart_snapshots"
    ).first()).toEqual({ count: 0 });
  });

  it("提交时失去租约时不二次提交或投递", async () => {
    const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
    let commitCalls = 0;
    vi.spyOn(Repository.prototype, "commitSnapshotUnderLease")
      .mockImplementation(async () => {
        commitCalls += 1;
        throw new LeaseLostError();
      });
    const pushFetch = vi.fn();

    await expect(runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, scheduledAt)) },
        usageSource: {
          fetch: vi.fn().mockResolvedValue({
            status: "complete",
            records: [usageRecord("usage-lease", scheduledAt - 60_000)],
            pagesRead: 1
          })
        },
        fetchImpl: pushFetch,
        now: () => scheduledAt
      }
    )).rejects.toBeInstanceOf(LeaseLostError);

    expect(commitCalls).toBe(1);
    expect(pushFetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events"
    ).first()).toEqual({ count: 0 });
  });

  it("图表快照清理失败不覆盖已完成广播或阻止投递", async () => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const cleanup = vi.spyOn(
      Repository.prototype,
      "deleteExpiredUsageChartSnapshots"
    ).mockRejectedValue(new Error("清理失败"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    expect(await runBroadcast(
      {
        type: "manual",
        occurredAt,
        idempotencyDigest: "cleanup-failure"
      },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, occurredAt)) },
        usageSource: {
          fetch: vi.fn().mockResolvedValue({
            status: "unavailable",
            reason: "not-authorized"
          })
        },
        fetchImpl: pushFetch,
        now: () => occurredAt
      }
    )).toBe("completed");

    expect(cleanup).toHaveBeenCalledWith(
      occurredAt - 30 * 24 * 60 * 60 * 1000,
      200
    );
    expect(pushFetch).toHaveBeenCalledOnce();
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

  it("手动采集失败时返回失败且不创建用量事件", async () => {
    const occurredAt = Date.parse("2026-08-05T16:30:00Z");
    const sourceFetch = vi.fn().mockRejectedValue(
      new SourceError("transient", "上游暂时不可用")
    );

    const result = await runBroadcast(
      {
        type: "manual",
        occurredAt,
        idempotencyDigest: "collector-failure"
      },
      testEnv(),
      {
        source: { fetch: sourceFetch },
        fetchImpl: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => occurredAt
      }
    );

    expect(result).toBe("failed");
    expect(sourceFetch).toHaveBeenCalledTimes(3);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE kind = 'daily'"
    ).first()).toEqual({ count: 0 });
  });

  it.each([
    ["PushPlus 拒绝", () => Promise.resolve(
      Response.json({ code: 500, data: "" })
    )],
    ["PushPlus 网络失败", () => Promise.reject(new Error("网络不可用"))]
  ])("手动首次投递遇到%s时返回失败", async (_caseName, send) => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const result = await runBroadcast(
      {
        type: "manual",
        occurredAt,
        idempotencyDigest: "push-failure-" + _caseName
      },
      testEnv(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, occurredAt)) },
        fetchImpl: vi.fn(send),
        now: () => occurredAt
      }
    );

    expect(result).toBe("failed");
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_events WHERE logical_key = ?"
    ).bind("broadcast:manual:push-failure-" + _caseName).first()).toEqual({
      status: "retryable"
    });
  });

  it("更早事件耗尽单次投递上限时不把未轮到的手动目标视为成功", async () => {
    const occurredAt = Date.parse("2026-08-05T02:30:00Z");
    const sourceFetch = vi.fn(async () => {
      await env.DB.batch(Array.from({ length: 5 }, (_unused, index) =>
        env.DB.prepare(
          "INSERT INTO outbox_events " +
          "(id, logical_key, kind, title, content, status, next_attempt_at, " +
          "not_after, created_at, updated_at) " +
          "VALUES (?, ?, 'daily', '较早事件', '较早事件', 'pending', ?, ?, ?, ?)"
        ).bind(
          "earlier-" + index,
          "earlier:" + index,
          occurredAt,
          occurredAt + 30 * 60 * 1000,
          occurredAt - 1,
          occurredAt - 1
        )
      ));
      return snapshot(20, occurredAt);
    });
    const pushFetch = vi.fn().mockResolvedValue(
      new Response("拒绝", { status: 503 })
    );

    const result = await runBroadcast(
      {
        type: "manual",
        occurredAt,
        idempotencyDigest: "not-reached"
      },
      testEnv(),
      {
        source: { fetch: sourceFetch },
        fetchImpl: pushFetch,
        now: () => occurredAt
      }
    );

    expect(result).toBe("failed");
    expect(pushFetch).toHaveBeenCalledTimes(5);
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_events WHERE logical_key = ?"
    ).bind("broadcast:manual:not-reached").first()).toEqual({
      status: "pending"
    });
  });

  it("手动任务持有快照租约时定时整点等待释放后仍完成广播", async () => {
    const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
    const manualAt = scheduledAt + 100;
    let announceSourceStarted!: () => void;
    const sourceStarted = new Promise<void>((resolve) => {
      announceSourceStarted = resolve;
    });
    let releaseManualSource!: (value: QuotaSnapshot) => void;
    const manualSourceFetch = vi.fn(() => {
      announceSourceStarted();
      return new Promise<QuotaSnapshot>((resolve) => {
        releaseManualSource = resolve;
      });
    });
    const pushFetch = vi.fn().mockImplementation(() => Promise.resolve(
      Response.json({ code: 200, data: "provider-id" })
    ));
    const manualPromise = runBroadcast(
      {
        type: "manual",
        occurredAt: manualAt,
        idempotencyDigest: "lease-holder"
      },
      testEnv(),
      {
        source: { fetch: manualSourceFetch },
        fetchImpl: pushFetch,
        now: () => manualAt
      }
    );
    await sourceStarted;

    let scheduledNow = scheduledAt;
    let manualReleased = false;
    const sleep = vi.fn(async () => {
      scheduledNow += 1000;
      if (!manualReleased) {
        manualReleased = true;
        releaseManualSource(snapshot(20, manualAt));
        await manualPromise;
      }
    });
    const scheduledResult = await runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: {
          fetch: vi.fn().mockResolvedValue(snapshot(21, scheduledAt + 1000))
        },
        fetchImpl: pushFetch,
        sleep,
        now: () => scheduledNow
      }
    );
    if (!manualReleased) {
      releaseManualSource(snapshot(20, manualAt));
      await manualPromise;
    }

    expect(scheduledResult).toBe("completed");
    expect(sleep).toHaveBeenCalled();
    const events = await env.DB.prepare(
      "SELECT logical_key, status FROM outbox_events ORDER BY logical_key"
    ).all<{ logical_key: string; status: string }>();
    expect(events.results).toEqual([
      { logical_key: "broadcast:manual:lease-holder", status: "succeeded" },
      { logical_key: "broadcast:scheduled:2026-08-05:09", status: "succeeded" }
    ]);
  });

  it("定时租约重试到槽位边界即停止且不采集或创建旧事件", async () => {
    const scheduledAt = Date.parse("2026-08-05T01:00:00Z");
    const slotEnd = Date.parse("2026-08-05T02:00:00Z");
    await env.DB.prepare(
      "UPDATE locks SET owner = 'manual-owner', lease_until = ? " +
      "WHERE name = 'snapshot'"
    ).bind(slotEnd + 1).run();
    let current = scheduledAt;
    const sourceFetch = vi.fn();
    const sleep = vi.fn(async () => {
      current = slotEnd;
    });

    const result = await runBroadcast(
      { type: "scheduled", occurredAt: scheduledAt },
      testEnv(),
      {
        source: { fetch: sourceFetch },
        fetchImpl: vi.fn(),
        sleep,
        now: () => current
      }
    );

    expect(result).toBe("busy");
    expect(sleep).toHaveBeenCalledOnce();
    expect(sourceFetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events"
    ).first()).toEqual({ count: 0 });
  });

  it("跨小时延迟的旧 Cron 槽位不补发且当前槽位仍可独立广播", async () => {
    const oldSlot = Date.parse("2026-08-05T01:00:00Z");
    const currentSlot = Date.parse("2026-08-05T02:00:00Z");
    const delayedNow = currentSlot + 60 * 1000;
    const oldSourceFetch = vi.fn().mockResolvedValue(snapshot(20, delayedNow));
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(oldSlot),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source: { fetch: oldSourceFetch }, fetchImpl: pushFetch, now: () => delayedNow }
    );
    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(currentSlot),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(21, delayedNow)) },
        fetchImpl: pushFetch,
        now: () => delayedNow
      }
    );

    expect(oldSourceFetch).not.toHaveBeenCalled();
    const events = await env.DB.prepare(
      "SELECT logical_key, not_after FROM outbox_events"
    ).all<{ logical_key: string; not_after: number }>();
    expect(events.results).toEqual([{
      logical_key: "broadcast:scheduled:2026-08-05:10",
      not_after: Date.parse("2026-08-05T03:00:00Z")
    }]);
  });

  it("夜间手动认证失败不发故障通知并由下一定时任务创建警告", async () => {
    const manualAt = Date.parse("2026-08-05T16:30:00Z");
    const scheduledAt = Date.parse("2026-08-06T01:00:00Z");
    const sourceFetch = vi.fn().mockRejectedValue(
      new SourceError("auth", "会话失效")
    );
    const pushFetch = vi.fn().mockResolvedValue(
      Response.json({ code: 200, data: "provider-id" })
    );

    expect(await runBroadcast(
      {
        type: "manual",
        occurredAt: manualAt,
        idempotencyDigest: "night-auth-failure"
      },
      testEnv(),
      { source: { fetch: sourceFetch }, fetchImpl: pushFetch, now: () => manualAt }
    )).toBe("failed");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events"
    ).first()).toEqual({ count: 0 });
    const runtimeBeforeScheduled = await env.DB.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'runtime'"
    ).first<{ value_json: string }>();
    expect(JSON.parse(runtimeBeforeScheduled!.value_json).faults.auth)
      .toMatchObject({ warningCreated: false });

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(scheduledAt),
        cron: "0 1-15 * * *"
      }),
      testEnv(),
      createExecutionContext(),
      { source: { fetch: sourceFetch }, fetchImpl: pushFetch, now: () => scheduledAt }
    );

    expect(sourceFetch).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(
      "SELECT kind, status FROM outbox_events"
    ).first()).toEqual({ kind: "fault", status: "succeeded" });
  });

  it("手动恢复只发送目标用量并把恢复通知留给下一定时任务", async () => {
    const at0900 = Date.parse("2026-08-05T01:00:00Z");
    const manualAt = Date.parse("2026-08-05T01:30:00Z");
    const at1000 = Date.parse("2026-08-05T02:00:00Z");
    const pushFetch = vi.fn().mockImplementation(() => Promise.resolve(
      Response.json({ code: 200, data: "provider-id" })
    ));
    const generationOne = testEnv();
    const generationTwo = {
      ...testEnv(),
      OPENCODE_AUTH_GENERATION: "generation-2"
    } as unknown as Cloudflare.Env;

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(at0900),
        cron: "0 1-15 * * *"
      }),
      generationOne,
      createExecutionContext(),
      {
        source: { fetch: vi.fn().mockRejectedValue(new SourceError("auth", "失效")) },
        fetchImpl: pushFetch,
        now: () => at0900
      }
    );
    expect(await runBroadcast(
      {
        type: "manual",
        occurredAt: manualAt,
        idempotencyDigest: "manual-recovery"
      },
      generationTwo,
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(20, manualAt)) },
        fetchImpl: pushFetch,
        now: () => manualAt
      }
    )).toBe("completed");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE kind = 'recovery'"
    ).first()).toEqual({ count: 0 });

    await runScheduled(
      createScheduledController({
        scheduledTime: new Date(at1000),
        cron: "0 1-15 * * *"
      }),
      generationTwo,
      createExecutionContext(),
      {
        source: { fetch: vi.fn().mockResolvedValue(snapshot(21, at1000)) },
        fetchImpl: pushFetch,
        now: () => at1000
      }
    );

    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE kind = 'recovery'"
    ).first()).toEqual({ count: 1 });
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
