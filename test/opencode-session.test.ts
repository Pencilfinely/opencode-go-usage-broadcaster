import { describe, expect, it, vi } from "vitest";
import { OpenCodeConsoleQuotaSource } from "../src/source";
import {
  parseOpenCodeGoResponse,
  type OpenCodeSessionBundleV1
} from "../src/opencode-session";

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
      url: "https://opencode.ai/workspace/workspace-1/go",
      method: "GET",
      headers: { accept: "text/html" },
      ...overrides
    }
  };
}

describe("OpenCode 控制台采集器", () => {
  it("保留 Go 页面 JSON 响应解析", () => {
    expect(parseOpenCodeGoResponse('{"answer":42}')).toEqual({ answer: 42 });
  });

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
      "https://opencode.ai/workspace/workspace-1/go",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({
          accept: "text/html",
          cookie: "auth=session-value"
        })
      })
    );
  });

  it("允许匹配工作区的隐藏 Go 页面 GET 请求", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      rollingUsage: { usagePercent: 49, resetInSec: 3600 },
      weeklyUsage: { usagePercent: 20, resetInSec: 7200 },
      monthlyUsage: { usagePercent: 10, resetInSec: 10800 }
    }));
    const source = new OpenCodeConsoleQuotaSource(
      bundle({
        url: "https://opencode.ai/workspace/workspace-1/go",
        method: "GET",
        headers: { accept: "text/html" }
      }),
      fetchImpl
    );

    const snapshot = await source.fetch(new Date("2026-08-04T01:00:00Z"));

    expect(snapshot.windows).toMatchObject({
      rolling: { usedPercent: 49, resetAt: "2026-08-04T02:00:00.000Z" },
      weekly: { usedPercent: 20, resetAt: "2026-08-04T03:00:00.000Z" },
      monthly: { usedPercent: 10, resetAt: "2026-08-04T04:00:00.000Z" }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/workspace-1/go",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("调用全局 fetch 时不把采集器实例绑定为接收者", async () => {
    let receiver: unknown = "尚未调用";
    const fetchImpl = function (this: unknown): Promise<Response> {
      receiver = this;
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({
        rollingUsage: { usagePercent: 49, resetInSec: 3600 },
        weeklyUsage: { usagePercent: 20, resetInSec: 7200 },
        monthlyUsage: { usagePercent: 10, resetInSec: 10800 }
      }));
    } as typeof fetch;
    const source = new OpenCodeConsoleQuotaSource(bundle(), fetchImpl);

    await expect(source.fetch(new Date("2026-08-04T01:00:00Z"))).resolves.toMatchObject({
      source: "opencode-console"
    });
    expect(receiver).toBeUndefined();
  });

  it("从 HTML 脚本中的两种赋值形式解析三个用量窗口", async () => {
    const html = `<!doctype html><script>
      rollingUsage:$R[12]={status:"ok",resetInSec:3600,usagePercent:49};
      weeklyUsage={status:"ok",resetInSec:7200,usagePercent:20};
      monthlyUsage:$R[3]={status:"rate-limited",resetInSec:10800,usagePercent:100};
    </script>`;
    const source = new OpenCodeConsoleQuotaSource(
      bundle(),
      vi.fn().mockResolvedValue(new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" }
      }))
    );

    const snapshot = await source.fetch(new Date("2026-08-04T01:00:00Z"));

    expect(snapshot.windows).toMatchObject({
      rolling: { usedPercent: 49, resetAt: "2026-08-04T02:00:00.000Z" },
      weekly: { usedPercent: 20, resetAt: "2026-08-04T03:00:00.000Z" },
      monthly: {
        status: "rate-limited",
        usedPercent: 100,
        resetAt: "2026-08-04T04:00:00.000Z"
      }
    });
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

  it("将同源 auth 登录重定向归类为认证错误", async () => {
    const source = new OpenCodeConsoleQuotaSource(
      bundle(),
      vi.fn().mockResolvedValue(new Response(null, {
        status: 302,
        headers: { location: "/auth" }
      }))
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "auth"
    });
  });

  it.each([301, 303])("将 %s 重定向归类为认证错误", async (status) => {
    const source = new OpenCodeConsoleQuotaSource(
      bundle(),
      vi.fn().mockResolvedValue(new Response(null, {
        status,
        headers: { location: "/workspace/workspace-1/go" }
      }))
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "auth"
    });
  });

  it("将跨源 login 重定向归类为结构错误", async () => {
    const source = new OpenCodeConsoleQuotaSource(
      bundle(),
      vi.fn().mockResolvedValue(new Response(null, {
        status: 302,
        headers: { location: "https://example.test/login" }
      }))
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
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
      bundle({ url: "https://example.test/workspace/workspace-1/go" }),
      fetchImpl
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["工作区不匹配", "https://opencode.ai/workspace/workspace-2/go", "GET"],
    ["旧版内部接口", "https://opencode.ai/_server/usage", "GET"],
    ["跨源", "https://example.test/workspace/workspace-1/go", "GET"],
    ["相似路径", "https://opencode.ai/workspace/workspace-1/go-extra", "GET"],
    ["附带查询参数", "https://opencode.ai/workspace/workspace-1/go?next=/auth", "GET"],
    ["非 GET 方法", "https://opencode.ai/workspace/workspace-1/go", "POST"]
  ])("拒绝%s的隐藏 Go 页面请求", async (_case, url, method) => {
    const fetchImpl = vi.fn();
    const source = new OpenCodeConsoleQuotaSource(
      bundle({ url, method }),
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
