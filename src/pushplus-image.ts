const ACCESS_KEY_URL = "https://www.pushplus.plus/api/upload/getAccessKey";
const UPLOAD_TOKEN_URL = "https://www.pushplus.plus/api/upload/getUploadToken";
const QINIU_UPLOAD_URL = "https://upload.qiniup.com/";
const PICTURE_HOST = "pic.pushplus.plus";
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_TOKEN_LENGTH = 8192;

export interface PushPlusImageConfig {
  token: string;
  secretKey: string;
}

export type PushPlusImageStage = "access_key" | "upload_token" | "upload";

export class PushPlusImageError extends Error {
  constructor(
    public readonly stage: PushPlusImageStage,
    category: "network" | "rejected" | "invalid"
  ) {
    super(`pushplus_image_${stage}_${category}`);
    this.name = "PushPlusImageError";
  }
}

function fail(stage: PushPlusImageStage, category: "network" | "rejected" | "invalid"): never {
  throw new PushPlusImageError(stage, category);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPng(png: Uint8Array): boolean {
  return png.byteLength <= MAX_PNG_BYTES && png.byteLength >= 8 &&
    png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47 &&
    png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a;
}

async function fetchWithTimeout<T>(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  stage: PushPlusImageStage,
  handleResponse: (response: Response, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    return await handleResponse(response, controller.signal);
  } catch (error) {
    if (error instanceof PushPlusImageError) throw error;
    return fail(stage, "network");
  } finally {
    clearTimeout(timeout);
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  stage: PushPlusImageStage
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new PushPlusImageError(stage, "network"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new PushPlusImageError(stage, "network"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function readBoundedJson(
  response: Response,
  stage: PushPlusImageStage,
  signal: AbortSignal
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_BYTES) {
      fail(stage, "invalid");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) fail(stage, "invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal, stage);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        fail(stage, "invalid");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PushPlusImageError) throw error;
    fail(stage, "network");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(stage, "invalid");
  }
}

function requireSuccessResponse(response: Response, stage: PushPlusImageStage): void {
  if (!response.ok) fail(stage, "rejected");
}

async function getAccessKey(config: PushPlusImageConfig, fetchImpl: typeof fetch): Promise<string> {
  return fetchWithTimeout(fetchImpl, ACCESS_KEY_URL, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: config.token, secretKey: config.secretKey })
  }, 8_000, "access_key", async (response, signal) => {
    requireSuccessResponse(response, "access_key");
    const payload = await readBoundedJson(response, "access_key", signal);
    if (!isRecord(payload)) {
      fail("access_key", "invalid");
    }
    if (payload.code !== 200) fail("access_key", "rejected");
    if (!isRecord(payload.data)) fail("access_key", "invalid");
    const { accessKey, expiresIn } = payload.data;
    if (typeof accessKey !== "string" || accessKey.length < 32 || accessKey.length > 512 || !isPositiveSafeInteger(expiresIn)) {
      fail("access_key", "invalid");
    }
    return accessKey;
  });
}

async function getUploadToken(accessKey: string, fetchImpl: typeof fetch): Promise<string> {
  return fetchWithTimeout(fetchImpl, UPLOAD_TOKEN_URL, {
    method: "GET",
    redirect: "error",
    headers: { "access-key": accessKey }
  }, 8_000, "upload_token", async (response, signal) => {
    requireSuccessResponse(response, "upload_token");
    const payload = await readBoundedJson(response, "upload_token", signal);
    if (!isRecord(payload)) {
      fail("upload_token", "invalid");
    }
    if (payload.code !== 200) fail("upload_token", "rejected");
    if (!isRecord(payload.data)) fail("upload_token", "invalid");
    const { uploadToken, uploadUrl, bucket, expiresIn } = payload.data;
    if (
      typeof uploadToken !== "string" || uploadToken.length === 0 || uploadToken.length > MAX_UPLOAD_TOKEN_LENGTH ||
      uploadUrl !== QINIU_UPLOAD_URL ||
      typeof bucket !== "string" || bucket.length === 0 || bucket.length > 512 ||
      !isPositiveSafeInteger(expiresIn)
    ) {
      fail("upload_token", "invalid");
    }
    return uploadToken;
  });
}

function validImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && url.hostname === PICTURE_HOST;
  } catch {
    return false;
  }
}

async function uploadPng(uploadToken: string, png: Uint8Array, fetchImpl: typeof fetch): Promise<string> {
  const copy = new Uint8Array(png.byteLength);
  copy.set(png);
  const form = new FormData();
  form.append("token", uploadToken);
  form.append("file", new Blob([copy.buffer], { type: "image/png" }), "usage-chart.png");
  return fetchWithTimeout(fetchImpl, QINIU_UPLOAD_URL, {
    method: "POST",
    redirect: "error",
    body: form
  }, 15_000, "upload", async (response, signal) => {
    requireSuccessResponse(response, "upload");
    const payload = await readBoundedJson(response, "upload", signal);
    if (!isRecord(payload) || payload.errno !== 0 || payload.mimeType !== "image/png" ||
      payload.fsize !== png.byteLength || !validImageUrl(payload.url)) {
      fail("upload", "invalid");
    }
    return payload.url;
  });
}

export async function uploadPushPlusPng(
  config: PushPlusImageConfig,
  png: Uint8Array,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!isPng(png)) fail("upload", "invalid");
  const accessKey = await getAccessKey(config, fetchImpl);
  const uploadToken = await getUploadToken(accessKey, fetchImpl);
  return uploadPng(uploadToken, png, fetchImpl);
}
