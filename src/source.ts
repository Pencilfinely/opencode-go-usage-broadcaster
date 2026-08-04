import type { AppConfig } from "./config";
import {
  CollectorDisabledError,
  SourceError,
  WINDOW_KEYS,
  type QuotaSnapshot,
  type QuotaSource,
  type UsageWindow,
  type WindowKey
} from "./domain";
import {
  normalizeOpenCodeUsage,
  OPENCODE_RESPONSE_LIMIT_BYTES,
  validateOpenCodeRequest,
  type OpenCodeSessionBundleV1
} from "./opencode-session";

type FixtureWindow = {
  status: "ok" | "rate-limited";
  resetInSec: number;
  usagePercent: number;
};

type FixturePayload = {
  error?: "auth" | "transient" | "schema";
  rollingUsage?: FixtureWindow;
  weeklyUsage?: FixtureWindow;
  monthlyUsage?: FixtureWindow;
};

function parseWindow(
  value: FixtureWindow | undefined,
  key: WindowKey,
  now: Date
): UsageWindow {
  if (!value) throw new SourceError("schema", "Missing window: " + key);
  if (value.status !== "ok" && value.status !== "rate-limited") {
    throw new SourceError("schema", "Invalid status: " + key);
  }
  if (
    !Number.isFinite(value.usagePercent) ||
    value.usagePercent < 0 ||
    value.usagePercent > 100
  ) {
    throw new SourceError("schema", "Invalid percentage: " + key);
  }
  if (!Number.isFinite(value.resetInSec) || value.resetInSec < 0) {
    throw new SourceError("schema", "Invalid reset: " + key);
  }
  const resetAt = now.getTime() + value.resetInSec * 1000;
  if (!Number.isFinite(resetAt) || Number.isNaN(new Date(resetAt).getTime())) {
    throw new SourceError("schema", "Reset is outside the valid range: " + key);
  }
  return {
    status: value.status,
    usedPercent: value.usagePercent,
    resetAt: new Date(resetAt).toISOString()
  };
}

export class FixtureQuotaSource implements QuotaSource {
  constructor(private readonly raw: string) {}

  async fetch(now: Date): Promise<QuotaSnapshot> {
    let value: FixturePayload;
    try {
      value = JSON.parse(this.raw) as FixturePayload;
    } catch {
      throw new SourceError("schema", "Fixture is not valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SourceError("schema", "Fixture must be an object");
    }
    if (value.error) {
      if (!["auth", "transient", "schema"].includes(value.error)) {
        throw new SourceError("schema", "Fixture has an invalid error kind");
      }
      throw new SourceError(value.error, "Fixture error: " + value.error);
    }
    const input = {
      rolling: value.rollingUsage,
      weekly: value.weeklyUsage,
      monthly: value.monthlyUsage
    };
    const windows = Object.fromEntries(
      WINDOW_KEYS.map((key) => [key, parseWindow(input[key], key, now)])
    ) as Record<WindowKey, UsageWindow>;

    return { source: "fixture", observedAt: now.toISOString(), windows };
  }
}

export class DisabledConsoleQuotaSource implements QuotaSource {
  async fetch(): Promise<QuotaSnapshot> {
    throw new CollectorDisabledError();
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > OPENCODE_RESPONSE_LIMIT_BYTES) {
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
      if (byteLength > OPENCODE_RESPONSE_LIMIT_BYTES) {
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

function isLoginRedirect(response: Response): boolean {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("location");
  return location !== null && /(?:^|[/?#])login(?:[/?#]|$)/iu.test(location);
}

export class OpenCodeConsoleQuotaSource implements QuotaSource {
  constructor(
    private readonly bundle: OpenCodeSessionBundleV1,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async fetch(now: Date): Promise<QuotaSnapshot> {
    const request = validateOpenCodeRequest(this.bundle.request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: { ...request.headers, cookie: this.bundle.auth.cookie },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "manual",
        signal: controller.signal
      });
    } catch {
      throw new SourceError("transient", "OpenCode 请求失败或超时");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403 || isLoginRedirect(response)) {
      throw new SourceError("auth", "OpenCode 会话已失效");
    }
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      throw new SourceError("transient", "OpenCode 服务暂时不可用");
    }
    if (!response.ok) {
      throw new SourceError("schema", "OpenCode 响应状态无效");
    }

    let text: string;
    try {
      text = await readLimitedText(response);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError("transient", "OpenCode 响应读取失败");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SourceError("schema", "OpenCode 响应不是有效 JSON");
    }
    return {
      source: "opencode-console",
      observedAt: now.toISOString(),
      windows: normalizeOpenCodeUsage(payload, now)
    };
  }
}

export function createQuotaSource(
  config: AppConfig,
  sourceFetchImpl: typeof fetch = fetch
): QuotaSource {
  if (config.sourceName === "fixture") {
    return new FixtureQuotaSource(config.fixtureJson);
  }
  if (config.consoleEnabled && config.sessionBundle) {
    return new OpenCodeConsoleQuotaSource(config.sessionBundle, sourceFetchImpl);
  }
  return new DisabledConsoleQuotaSource();
}
