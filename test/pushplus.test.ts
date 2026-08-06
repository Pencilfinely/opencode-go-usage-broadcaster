import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedEvent, Repository } from "../src/repository";
import {
  dispatchDue,
  handlePushPlusCallback,
  signCallback,
  verifyCallback
} from "../src/pushplus";

const secret = "test-callback-secret-32-bytes-minimum";
const now = Date.parse("2026-08-03T12:00:00Z");

afterEach(() => {
  vi.restoreAllMocks();
});

function claimedEvent(overrides: Partial<ClaimedEvent> = {}): ClaimedEvent {
  return {
    id: "event-1",
    logicalKey: "threshold:rolling:50",
    kind: "threshold",
    title: "Usage warning",
    content: "Rolling usage reached 50%.",
    attemptCount: 1,
    notAfter: now + 60_000,
    leaseOwner: "dispatcher-owner",
    leaseUntil: now + 60_000,
    ...overrides
  };
}

function dispatchRepository(events: ClaimedEvent[]) {
  const remaining = [...events];
  return {
    claimDueEvent: vi.fn(async (owner: string) => {
      const event = remaining.shift();
      return event ? { ...event, leaseOwner: owner } : null;
    }),
    prepareDispatchClaim: vi.fn(async (
      _eventId: string,
      _attemptNo: number,
      _owner: string,
      current: number,
      leaseMs: number
    ) => current + leaseMs),
    expireOrRequeueClaim: vi.fn(async () => true),
    markAttemptAccepted: vi.fn(async () => true),
    markAttemptFailure: vi.fn(async () => true)
  };
}

function callbackRequest(
  eventId: string,
  expires: number,
  signature: string,
  sendStatus: 2 | 3 = 2
): Request {
  return new Request(
    "https://worker.test/callbacks/pushplus/" +
      encodeURIComponent(eventId) +
      "/" +
      expires +
      "/" +
      signature,
    {
      method: "POST",
      body: JSON.stringify({
        event: "message_complate",
        messageInfo: {
          message: "",
          shortCode: "provider-1",
          sendStatus
        }
      })
    }
  );
}

describe("PushPlus callback", () => {
  it("rejects a changed event or deadline", async () => {
    const expires = Date.parse("2026-08-04T00:00:00Z");
    const signature = await signCallback(secret, "event-1", expires);

    await expect(
      verifyCallback(secret, "event-2", expires, signature)
    ).resolves.toBe(false);
    await expect(
      verifyCallback(secret, "event-1", expires + 1, signature)
    ).resolves.toBe(false);
  });

  it("accepts a valid final-success callback", async () => {
    const expires = Date.now() + 60_000;
    const signature = await signCallback(secret, "event-1", expires);
    const markSuccess = vi.fn().mockResolvedValue(true);
    const request = callbackRequest("event-1", expires, signature);

    const response = await handlePushPlusCallback(
      request,
      { callbackSecret: secret },
      {
        markCallbackSuccess: markSuccess,
        markCallbackFailure: vi.fn()
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ code: 200, msg: "success" });
    expect(markSuccess).toHaveBeenCalledWith(
      "event-1",
      "provider-1",
      expect.any(Number)
    );
  });

  it("rejects an expired signed callback before touching D1", async () => {
    const expires = Date.now() - 1;
    const signature = await signCallback(secret, "event-1", expires);
    const markSuccess = vi.fn();
    const response = await handlePushPlusCallback(
      callbackRequest("event-1", expires, signature),
      { callbackSecret: secret },
      {
        markCallbackSuccess: markSuccess,
        markCallbackFailure: vi.fn()
      }
    );

    expect(response.status).toBe(404);
    expect(markSuccess).not.toHaveBeenCalled();
  });

  it("records a final-failure callback with a 30-minute retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const expires = now + 60_000;
    const signature = await signCallback(secret, "event-1", expires);
    const markFailure = vi.fn().mockResolvedValue(true);

    const response = await handlePushPlusCallback(
      callbackRequest("event-1", expires, signature, 3),
      { callbackSecret: secret },
      {
        markCallbackSuccess: vi.fn(),
        markCallbackFailure: markFailure
      }
    );

    expect(response.status).toBe(200);
    expect(markFailure).toHaveBeenCalledWith(
      "event-1",
      "provider-1",
      now,
      now + 30 * 60 * 1000
    );
  });

  it("returns 404 when the repository rejects an unknown callback", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const expires = now + 60_000;
    const signature = await signCallback(secret, "event-1", expires);

    const response = await handlePushPlusCallback(
      callbackRequest("event-1", expires, signature),
      { callbackSecret: secret },
      {
        markCallbackSuccess: vi.fn().mockResolvedValue(false),
        markCallbackFailure: vi.fn()
      }
    );

    expect(response.status).toBe(404);
  });

  it("rejects a declared body larger than 4096 bytes before reading it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const expires = now + 60_000;
    const signature = await signCallback(secret, "event-1", expires);
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([123, 125]));
        controller.close();
      }
    });
    const request = new Request(
      "https://worker.test/callbacks/pushplus/event-1/" + expires + "/" + signature,
      {
        method: "POST",
        headers: { "content-length": "4097" },
        body
      }
    );
    pulled = false;

    const response = await handlePushPlusCallback(
      request,
      { callbackSecret: secret },
      {
        markCallbackSuccess: vi.fn(),
        markCallbackFailure: vi.fn()
      }
    );

    expect(response.status).toBe(404);
    expect(pulled).toBe(false);
  });

  it("cancels an unbounded raw body immediately above 4096 bytes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const expires = now + 60_000;
    const signature = await signCallback(secret, "event-1", expires);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
      cancel() {
        cancelled = true;
      }
    });
    const request = new Request(
      "https://worker.test/callbacks/pushplus/event-1/" + expires + "/" + signature,
      { method: "POST", body }
    );

    const response = await handlePushPlusCallback(
      request,
      { callbackSecret: secret },
      {
        markCallbackSuccess: vi.fn(),
        markCallbackFailure: vi.fn()
      }
    );

    expect(response.status).toBe(404);
    expect(cancelled).toBe(true);
  });

  it("rejects a callback whose body read crosses the signed expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const expires = now + 10;
    const signature = await signCallback(secret, "event-slow", expires);
    let current = now;
    const body = JSON.stringify({
      event: "message_complate",
      messageInfo: {
        message: "",
        shortCode: "provider-slow",
        sendStatus: 2
      }
    });
    const request = new Request(
      "https://worker.test/callbacks/pushplus/event-slow/" + expires + "/" + signature,
      {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            current = expires;
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }
        })
      }
    );
    const markSuccess = vi.fn().mockResolvedValue(true);

    const response = await handlePushPlusCallback(
      request,
      { callbackSecret: secret },
      {
        markCallbackSuccess: markSuccess,
        markCallbackFailure: vi.fn()
      },
      () => current
    );

    expect(response.status).toBe(404);
    expect(markSuccess).not.toHaveBeenCalled();
  });
});

describe("PushPlus dispatch", () => {
  it("发送带签名的固定结构载荷并记录服务商接受结果", async () => {
    const richContent =
      '最近 24 小时总 Token：380<br><img src="https://worker.test/chart.svg?sig=abc">';
    const event = claimedEvent({ content: richContent });
    const repo = dispatchRepository([event]);
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) =>
      new Response(JSON.stringify({ code: 200, data: "provider-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const report = await dispatchDue(
      repo as unknown as Repository,
      {
        token: "pushplus-token",
        topic: "pushplus-topic",
        callbackSecret: secret,
        callbackBaseUrl: "https://worker.test"
      },
      () => now,
      fetchImpl
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://www.pushplus.plus/send");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      token: "pushplus-token",
      topic: "pushplus-topic",
      title: event.title,
      content: richContent,
      template: "html",
      channel: "wechat",
      timestamp: event.notAfter
    });
    const callbackUrl = new URL(String(payload.callbackUrl));
    const segments = callbackUrl.pathname.split("/").filter(Boolean);
    expect(segments.slice(0, 4)).toEqual([
      "callbacks",
      "pushplus",
      event.id,
      String(event.notAfter)
    ]);
    await expect(
      verifyCallback(secret, event.id, event.notAfter, segments[4]!)
    ).resolves.toBe(true);
    expect(repo.markAttemptAccepted).toHaveBeenCalledWith(
      event.id,
      event.attemptCount,
      expect.any(String),
      "provider-1",
      now
    );
    expect(repo.markAttemptFailure).not.toHaveBeenCalled();
    expect(report).toEqual({
      acceptedEventIds: [event.id],
      failedEventIds: []
    });
  });

  it("records a bounded retry transition when PushPlus rejects a request", async () => {
    const event = claimedEvent();
    const repo = dispatchRepository([event]);
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => new Response("denied", { status: 503 }));

    const report = await dispatchDue(
      repo as unknown as Repository,
      {
        token: "pushplus-token",
        topic: "pushplus-topic",
        callbackSecret: secret,
        callbackBaseUrl: "https://worker.test"
      },
      () => now,
      fetchImpl
    );

    expect(repo.markAttemptFailure).toHaveBeenCalledWith(
      event.id,
      event.attemptCount,
      expect.any(String),
      now,
      now + 30 * 60 * 1000
    );
    expect(repo.markAttemptAccepted).not.toHaveBeenCalled();
    expect(report).toEqual({
      acceptedEventIds: [],
      failedEventIds: [event.id]
    });
  });

  it("网络失败时报告目标事件首次投递失败", async () => {
    const event = claimedEvent();
    const repo = dispatchRepository([event]);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("网络不可用"));

    const report = await dispatchDue(
      repo as unknown as Repository,
      {
        token: "pushplus-token",
        topic: "pushplus-topic",
        callbackSecret: secret,
        callbackBaseUrl: "https://worker.test"
      },
      () => now,
      fetchImpl
    );

    expect(repo.markAttemptFailure).toHaveBeenCalledWith(
      event.id,
      event.attemptCount,
      expect.any(String),
      now,
      now + 30 * 60 * 1000
    );
    expect(report).toEqual({
      acceptedEventIds: [],
      failedEventIds: [event.id]
    });
  });

  it.each([
    ["notAfter", { notAfter: now + 10, leaseUntil: now + 60_000 }, now + 10],
    ["lease", { notAfter: now + 120_000, leaseUntil: now + 10 }, now + 10]
  ] as const)("does not send when a resumed claim reaches its %s boundary", async (
    _boundary,
    overrides,
    boundaryNow
  ) => {
    const event = claimedEvent(overrides);
    const repo = dispatchRepository([event]);
    const times = [now, boundaryNow];
    const clock = () => times.shift() ?? boundaryNow;
    const fetchImpl = vi.fn();

    await dispatchDue(
      repo as unknown as Repository,
      {
        token: "pushplus-token",
        topic: "pushplus-topic",
        callbackSecret: secret,
        callbackBaseUrl: "https://worker.test"
      },
      clock,
      fetchImpl
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.expireOrRequeueClaim).toHaveBeenCalledWith(
      event.id,
      event.attemptCount,
      expect.any(String),
      boundaryNow
    );
  });

  it.each([
    ["notAfter", { notAfter: now + 10, leaseUntil: now + 60_000 }, now + 10],
    ["renewed lease", { notAfter: now + 120_000, leaseUntil: now + 60_000 }, now + 60_000]
  ] as const)("checks %s again after claim preparation stalls", async (
    _boundary,
    overrides,
    boundaryNow
  ) => {
    const event = claimedEvent(overrides);
    const repo = dispatchRepository([event]);
    let current = now;
    repo.prepareDispatchClaim.mockImplementation(async () => {
      current = boundaryNow;
      return boundaryNow;
    });
    const fetchImpl = vi.fn();

    await dispatchDue(
      repo as unknown as Repository,
      {
        token: "pushplus-token",
        topic: "pushplus-topic",
        callbackSecret: secret,
        callbackBaseUrl: "https://worker.test"
      },
      () => current,
      fetchImpl
    );

    expect(repo.prepareDispatchClaim).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.expireOrRequeueClaim).toHaveBeenCalledWith(
      event.id,
      event.attemptCount,
      expect.any(String),
      boundaryNow
    );
  });
});
