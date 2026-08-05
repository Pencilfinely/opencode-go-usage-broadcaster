import { describe, expect, it, vi } from "vitest";
import type { BroadcastTrigger } from "../src/app";
import type { AppConfig } from "../src/config";
import { handleManualTrigger } from "../src/manual-trigger";

const SECRET = "manual-trigger-secret-at-least-32-characters";
const IDEMPOTENCY_KEY = "manual-1234567890";
const IDEMPOTENCY_DIGEST =
  "c1c96de5a95460fa2343d3c2333adb3a55874a11a41fc85c556cdbab7e13bcf8";

const config = {
  manualTriggerSecret: SECRET
} as AppConfig;

function request(
  path = "/admin/manual-trigger",
  init: RequestInit = {}
): Request {
  return new Request("https://worker.test" + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + SECRET,
      "idempotency-key": IDEMPOTENCY_KEY
    },
    ...init
  });
}

describe("安全手动广播入口", () => {
  it.each([
    ["GET 请求", request("/admin/manual-trigger", { method: "GET" })],
    ["带查询字符串", request("/admin/manual-trigger?force=1")],
    ["带空查询字符串", request("/admin/manual-trigger?")],
    ["缺少 Bearer", request("/admin/manual-trigger", { headers: {
      "idempotency-key": IDEMPOTENCY_KEY
    } })],
    ["Bearer 错误", request("/admin/manual-trigger", { headers: {
      authorization: "Bearer wrong-secret",
      "idempotency-key": IDEMPOTENCY_KEY
    } })]
  ])("%s 时隐藏入口且不执行广播", async (_caseName, manualRequest) => {
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"completed">>();

    const response = await handleManualTrigger(
      manualRequest,
      config,
      run,
      () => Date.parse("2026-08-05T16:30:00Z")
    );

    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["过短", "short"],
    ["包含非法字符", "manual key with spaces"]
  ])("幂等键%s时拒绝请求且不执行广播", async (_caseName, key) => {
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"completed">>();
    const response = await handleManualTrigger(
      request("/admin/manual-trigger", { headers: {
        authorization: "Bearer " + SECRET,
        "idempotency-key": key
      } }),
      config,
      run
    );

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("北京时间夜间仍使用服务端时间执行一次广播且只传幂等键摘要", async () => {
    const occurredAt = Date.parse("2026-08-05T16:30:00Z");
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"completed">>()
      .mockResolvedValue("completed");

    const response = await handleManualTrigger(
      request(),
      config,
      run,
      () => occurredAt
    );

    expect(response.status).toBe(204);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      type: "manual",
      occurredAt,
      idempotencyDigest: IDEMPOTENCY_DIGEST
    });
    expect(JSON.stringify(run.mock.calls)).not.toContain(IDEMPOTENCY_KEY);
  });

  it("相同请求交给广播任务去重而不在入口缓存", async () => {
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"completed" | "duplicate">>()
      .mockResolvedValueOnce("completed")
      .mockResolvedValueOnce("duplicate");

    const first = await handleManualTrigger(request(), config, run);
    const second = await handleManualTrigger(request(), config, run);

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("广播任务繁忙时返回可重试状态", async () => {
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"busy">>()
      .mockResolvedValue("busy");

    const response = await handleManualTrigger(request(), config, run);

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toMatch(/[\u4e00-\u9fff]/u);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(IDEMPOTENCY_KEY);
  });

  it("广播采集或首次投递失败时返回通用上游错误", async () => {
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"failed">>()
      .mockResolvedValue("failed");

    const response = await handleManualTrigger(request(), config, run);

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toMatch(/[\u4e00-\u9fff]/u);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(IDEMPOTENCY_KEY);
  });

  it("广播内部异常时返回不泄露细节的通用错误", async () => {
    const sensitiveDetail = "上游响应含敏感会话";
    const run = vi.fn<(trigger: BroadcastTrigger) => Promise<"completed">>()
      .mockRejectedValue(new Error(sensitiveDetail));

    const response = await handleManualTrigger(request(), config, run);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(sensitiveDetail);
  });
});
