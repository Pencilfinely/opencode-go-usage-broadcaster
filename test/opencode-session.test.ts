import { describe, expect, it, vi } from "vitest";
import { OpenCodeConsoleQuotaSource } from "../src/source";
import type { OpenCodeSessionBundleV1 } from "../src/opencode-session";

function bundle(
  overrides: Partial<OpenCodeSessionBundleV1["request"]> = {}
): OpenCodeSessionBundleV1 {
  return {
    version: 1,
    generation: "generation-2",
    createdAt: "2026-08-04T00:00:00.000Z",
    workspaceId: "workspace-1",
    auth: { cookie: "auth=session-value" },
    request: {
      url: "https://opencode.ai/_server/usage",
      method: "GET",
      headers: { accept: "application/json" },
      ...overrides
    }
  };
}

describe("OpenCode 控制台采集器", () => {
  it("将嵌套响应中的三个用量窗口规范化为快照", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      result: {
        rollingUsage: { usagePercent: 49, resetInSec: 3600 },
        weeklyUsage: { usagePercent: 20, resetInSec: 7200 },
        monthlyUsage: { usagePercent: 10, resetInSec: 10800 }
      }
    }));
    const source = new OpenCodeConsoleQuotaSource(bundle(), fetchImpl);

    const snapshot = await source.fetch(new Date("2026-08-04T01:00:00Z"));

    expect(snapshot).toMatchObject({
      source: "opencode-console",
      observedAt: "2026-08-04T01:00:00.000Z",
      windows: {
        rolling: { status: "ok", usedPercent: 49 },
        weekly: { status: "ok", usedPercent: 20 },
        monthly: { status: "ok", usedPercent: 10 }
      }
    });
    expect(snapshot.windows.monthly.resetAt).toBe("2026-08-04T04:00:00.000Z");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/_server/usage",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({
          accept: "application/json",
          cookie: "auth=session-value"
        })
      })
    );
  });

  it("将未认证响应归类为认证错误", async () => {
    const source = new OpenCodeConsoleQuotaSource(
      bundle(),
      vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "auth"
    });
  });

  it("将缺少用量窗口的响应归类为结构错误", async () => {
    const source = new OpenCodeConsoleQuotaSource(
      bundle(),
      vi.fn().mockResolvedValue(Response.json({
        rollingUsage: { usagePercent: 49, resetInSec: 3600 },
        weeklyUsage: { usagePercent: 20, resetInSec: 7200 }
      }))
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
    });
  });

  it("拒绝越出 OpenCode 固定来源边界的请求", async () => {
    const fetchImpl = vi.fn();
    const source = new OpenCodeConsoleQuotaSource(
      bundle({ url: "https://example.test/_server/usage" }),
      fetchImpl
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("将响应体读取纳入十秒超时", async () => {
    vi.useFakeTimers();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      bodyReading = resolve;
    });
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          init.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("超时", "AbortError"));
          }, { once: true });
          bodyReading();
        }
      });
      return Promise.resolve(new Response(body));
    });
    const source = new OpenCodeConsoleQuotaSource(bundle(), fetchImpl);
    const pending = source.fetch(new Date());
    let failure: unknown;
    void pending.catch((error: unknown) => {
      failure = error;
    });

    try {
      await reading;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(failure).toMatchObject({ kind: "transient" });
    } finally {
      bodyController?.error(new DOMException("清理", "AbortError"));
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
