import { SourceError } from "./domain";
import type { OpenCodeRequestDescriptor } from "./opencode-session";

const MAX_RESPONSE_BYTES = 512 * 1024;

export interface OpenCodeReplayResult {
  text: string;
  contentType: string;
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new SourceError("schema", "响应体超过限制");
  }
  if (!response.body) return "";
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
  return new TextDecoder().decode(bytes);
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
  outerSignal?: AbortSignal
): Promise<OpenCodeReplayResult> {
  const controller = new AbortController();
  const abortFromOuter = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) abortFromOuter();
  else outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: { ...request.headers, cookie },
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
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new SourceError("transient", "OpenCode 服务暂时不可用");
    }
    if (!response.ok) {
      throw new SourceError("schema", "OpenCode 响应状态无效");
    }
    try {
      const text = await readLimitedText(response);
      const contentType = response.headers.get("content-type");
      if (!contentType) {
        throw new SourceError("schema", "OpenCode 响应类型无效");
      }
      return { text, contentType };
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
