import { SourceError } from "./domain";
import type { OpenCodeRequestDescriptor } from "./opencode-session";

const MAX_RESPONSE_BYTES = 512 * 1024;

export interface OpenCodeReplayResult {
  body: Uint8Array;
  text: string;
  contentType: string;
}

export interface OpenCodeReplayOptions {
  serverInstance?: string;
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new SourceError("schema", "响应体超过限制");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        throw new SourceError("schema", "响应体超过限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeReplayText(body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SourceError("schema", "OpenCode 响应不是有效 UTF-8");
  }
}

function isLoginRedirect(response: Response, requestUrl: string): boolean {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("location");
  if (location === null) return false;
  try {
    const redirect = new URL(location, requestUrl);
    return redirect.origin === "https://opencode.ai" && /^\/auth\/?$/u.test(redirect.pathname);
  } catch {
    return false;
  }
}

export async function replayOpenCodeRequest(
  request: OpenCodeRequestDescriptor,
  cookie: string,
  fetchImpl: typeof fetch = fetch,
  outerSignal?: AbortSignal,
  options: OpenCodeReplayOptions = {}
): Promise<OpenCodeReplayResult> {
  if (
    options.serverInstance !== undefined &&
    !/^server-fn:[0-9]+$/u.test(options.serverInstance)
  ) {
    throw new SourceError("schema", "OpenCode 服务实例无效");
  }
  const controller = new AbortController();
  const abortFromOuter = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) abortFromOuter();
  else outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      const headers = new Headers(request.headers);
      headers.set("cookie", cookie);
      headers.delete("x-server-id");
      headers.delete("x-server-instance");
      if (options.serverInstance !== undefined) {
        headers.set("x-server-instance", options.serverInstance);
      }
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: Object.fromEntries(headers.entries()),
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "manual",
        signal: controller.signal
      });
    } catch {
      throw new SourceError("transient", "OpenCode 请求失败或超时");
    }
    if (
      response.status === 301 ||
      response.status === 303 ||
      response.status === 401 ||
      response.status === 403 ||
      isLoginRedirect(response, request.url)
    ) {
      throw new SourceError("auth", "OpenCode 会话已失效");
    }
    if (
      response.status === 308 ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new SourceError("transient", "OpenCode 服务暂时不可用");
    }
    if (!response.ok) {
      throw new SourceError("schema", "OpenCode 响应状态无效");
    }
    try {
      const body = await readLimitedBody(response);
      const contentType = response.headers.get("content-type");
      if (!contentType) {
        throw new SourceError("schema", "OpenCode 响应类型无效");
      }
      return {
        body,
        contentType,
        get text() {
          return decodeReplayText(body);
        }
      };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError("transient", "OpenCode 响应读取失败");
    }
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

export const OPENCODE_RESPONSE_LIMIT_BYTES = MAX_RESPONSE_BYTES;
