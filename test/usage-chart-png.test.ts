import { describe, expect, it } from "vitest";
import type { UsageAggregate } from "../src/usage-domain";
import { renderUsageChartPng } from "../src/usage-chart-png";

function aggregate(): UsageAggregate {
  const windowStartAt = Date.parse("2026-08-04T04:00:00.000Z");
  return {
    observedAt: Date.parse("2026-08-05T03:30:00.000Z"),
    windowStartAt,
    truncated: false,
    requestCount: 1,
    costMicroCents: 1,
    tokens: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 2
    },
    buckets: Array.from({ length: 24 }, (_, index) => ({
      startAt: windowStartAt + index * 60 * 60 * 1000,
      inputTokens: index,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheTokens: 0
    })),
    models: []
  };
}

function validPng(width = 720, height = 360): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function pngResponse(width = 720, height = 360): Response {
  return new Response(toArrayBuffer(validPng(width, height)), {
    headers: { "content-type": "image/png" }
  });
}

function browserReturning(response: Response): Pick<BrowserRun, "quickAction"> {
  return {
    async quickAction() {
      return response;
    }
  };
}

describe("用量 PNG 图表", () => {
  it("将现有 SVG 渲染为固定尺寸的 PNG", async () => {
    let receivedAction: string | undefined;
    let receivedOptions: unknown;
    const browser: Pick<BrowserRun, "quickAction"> = {
      async quickAction(action, options) {
        receivedAction = action;
        receivedOptions = options;
        return new Response(toArrayBuffer(validPng()), {
          headers: {
            "content-type": "image/png",
            "x-browser-ms-used": "321"
          }
        });
      }
    };

    const result = await renderUsageChartPng(browser, aggregate());

    expect([...result.bytes.slice(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    expect(result.browserMs).toBe(321);
    expect(receivedAction).toBe("screenshot");
    expect(receivedOptions).toMatchObject({
      viewport: { width: 720, height: 360, deviceScaleFactor: 1 },
      selector: "body > svg",
      setJavaScriptEnabled: false,
      actionTimeout: 10_000,
      cacheTTL: 0,
      screenshotOptions: {
        type: "png",
        encoding: "binary",
        omitBackground: false
      }
    });
    expect(receivedOptions).toMatchObject({
      html: expect.stringContaining("最近 24 小时 Token")
    });
    expect(receivedOptions).toMatchObject({
      html: expect.stringContaining("default-src 'none'")
    });
  });

  it.each([
    ["HTTP 失败", new Response("secret", { status: 429 })],
    ["MIME 错误", new Response(toArrayBuffer(validPng()), { headers: { "content-type": "text/plain" } })],
    ["PNG 魔数错误", new Response(toArrayBuffer(new Uint8Array(32)), { headers: { "content-type": "image/png" } })],
    ["PNG 尺寸错误", pngResponse(719, 360)]
  ])("拒绝%s", async (_name, response) => {
    await expect(renderUsageChartPng(browserReturning(response), aggregate()))
      .rejects.toThrow("usage_chart_png_invalid");
  });

  it("取消无长度且超过上限的 PNG 流，且错误不泄漏响应正文", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(validPng());
        controller.enqueue(new TextEncoder().encode("secret"));
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      },
      cancel() {
        cancelled = true;
      }
    }), { headers: { "content-type": "image/png" } });

    let message = "";
    try {
      await renderUsageChartPng(browserReturning(response), aggregate());
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toBe("usage_chart_png_invalid");
    expect(message).not.toContain("secret");
    expect(cancelled).toBe(true);
  });
});
