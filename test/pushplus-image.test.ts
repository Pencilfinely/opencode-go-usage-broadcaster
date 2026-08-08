import { describe, expect, it, vi } from "vitest";
import { uploadPushPlusPng } from "../src/pushplus-image";

function validPng(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x02, 0xd0, 0x00, 0x00, 0x01, 0x68
  ]);
}

function accessKeyResponse(data: Record<string, unknown> = {
  accessKey: "a".repeat(32),
  expiresIn: 7200
}): Response {
  return Response.json({ code: 200, msg: "请求成功", data });
}

function uploadTokenResponse(uploadUrl = "https://upload.qiniup.com/"): Response {
  return Response.json({
    code: 200,
    msg: "执行成功",
    data: {
      uploadToken: "upload-token",
      uploadHost: "https://upload.qiniup.com",
      uploadUrl,
      bucket: "pushplus-img",
      expiresIn: 600
    }
  });
}

function uploadResponse(png: Uint8Array, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    errno: 0,
    ext: ".png",
    fname: "chart.png",
    fsize: png.byteLength,
    hash: "hash",
    key: "1/chart.png",
    mimeType: "image/png",
    msg: "ok",
    thumbnail: "https://pic.pushplus.plus/1/chart.png@s",
    url: "https://pic.pushplus.plus/1/chart.png@p",
    ...overrides
  });
}

function fetchSequence(responses: Response[]): typeof fetch {
  return async () => {
    const response = responses.shift();
    if (!response) throw new Error("测试响应已耗尽");
    return response;
  };
}

describe("PushPlus 图片上传客户端", () => {
  it("依照官方三步边界上传 PNG 并返回受信任的图片地址", async () => {
    const png = validPng();
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      if (requests.length === 1) {
        return Response.json({
          code: 200,
          msg: "请求成功",
          data: { accessKey: "a".repeat(32), expiresIn: 7200 }
        });
      }
      if (requests.length === 2) {
        return Response.json({
          code: 200,
          msg: "执行成功",
          data: {
            uploadToken: "upload-token",
            uploadHost: "https://upload.qiniup.com",
            uploadUrl: "https://upload.qiniup.com/",
            bucket: "pushplus-img",
            expiresIn: 600
          }
        });
      }
      return Response.json({
        errno: 0,
        ext: ".png",
        fname: "chart.png",
        fsize: png.byteLength,
        hash: "hash",
        key: "1/chart.png",
        mimeType: "image/png",
        msg: "ok",
        thumbnail: "https://pic.pushplus.plus/1/chart.png@s",
        url: "https://pic.pushplus.plus/1/chart.png@p"
      });
    };

    await expect(uploadPushPlusPng({ token: "token", secretKey: "secret" }, png, fetchImpl))
      .resolves.toBe("https://pic.pushplus.plus/1/chart.png@p");

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      input: "https://www.pushplus.plus/api/upload/getAccessKey",
      init: { method: "POST", redirect: "error" }
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ token: "token", secretKey: "secret" });
    expect(requests[1]).toMatchObject({
      input: "https://www.pushplus.plus/api/upload/getUploadToken",
      init: { method: "GET", redirect: "error", headers: { "access-key": "a".repeat(32) } }
    });
    expect(requests[2]).toMatchObject({
      input: "https://upload.qiniup.com/",
      init: { method: "POST", redirect: "error" }
    });
    expect(requests[2]?.init?.headers).toBeUndefined();
    expect(requests[2]?.init?.body).toBeInstanceOf(FormData);
    const form = requests[2]?.init?.body as FormData;
    expect(form.get("token")).toBe("upload-token");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe("image/png");
  });

  it("将 AccessKey 服务端拒绝归类为固定拒绝错误", async () => {
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" },
      validPng(),
      fetchSequence([Response.json({ code: 500, msg: "拒绝", data: {} })])
    )).rejects.toThrow("pushplus_image_access_key_rejected");
  });

  it("将缺少 AccessKey 归类为固定结构错误", async () => {
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" },
      validPng(),
      fetchSequence([accessKeyResponse({ expiresIn: 7200 })])
    )).rejects.toThrow("pushplus_image_access_key_invalid");
  });

  it.each([
    "http://upload.qiniup.com/",
    "https://upload.example.test/",
    "https://upload.qiniup.com/path",
    "https://upload.qiniup.com/?query=1"
  ])("拒绝非唯一七牛地址 %s", async (uploadUrl) => {
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" },
      validPng(),
      fetchSequence([accessKeyResponse(), uploadTokenResponse(uploadUrl)])
    )).rejects.toThrow("pushplus_image_upload_token_invalid");
  });

  it("将上传凭证请求的重定向视为失败", async () => {
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" },
      validPng(),
      fetchSequence([accessKeyResponse(), new Response(null, { status: 302 })])
    )).rejects.toThrow("pushplus_image_upload_token_rejected");
  });

  it.each([
    ["errno", { errno: 1 }],
    ["MIME", { mimeType: "text/plain" }],
    ["大小", { fsize: 1 }],
    ["最终主机", { url: "https://example.test/1/chart.png" }]
  ])("拒绝七牛上传响应的错误%s", async (_name, overrides) => {
    const png = validPng();
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" },
      png,
      fetchSequence([accessKeyResponse(), uploadTokenResponse(), uploadResponse(png, overrides)])
    )).rejects.toThrow("pushplus_image_upload_invalid");
  });

  it.each([
    ["非 PNG", new Uint8Array(8)],
    ["超过 2 MiB", (() => {
      const png = new Uint8Array(2 * 1024 * 1024 + 1);
      png.set(validPng());
      return png;
    })()]
  ])("在输入%s时不发起网络请求", async (_name, png) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" }, png, fetchImpl
    )).rejects.toThrow("pushplus_image_upload_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("取消超过 64 KiB 的 JSON 流", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      }
    }));
    await expect(uploadPushPlusPng(
      { token: "token", secretKey: "secret" }, validPng(), fetchSequence([response])
    )).rejects.toThrow("pushplus_image_access_key_invalid");
    expect(cancelled).toBe(true);
  });

  it("不将上游敏感正文写入错误或控制台", async () => {
    const marker = "token-secret-marker";
    const errorSpy = vi.spyOn(console, "error");
    try {
      await expect(uploadPushPlusPng(
        { token: "token", secretKey: "secret" },
        validPng(),
        fetchSequence([Response.json({ code: 200, msg: marker, data: {} })])
      )).rejects.not.toThrow(marker);
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(marker);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
