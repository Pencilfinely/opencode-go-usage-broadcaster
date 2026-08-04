import { SourceError, type UsageWindow, type WindowKey } from "./domain";

export interface OpenCodeSessionBundleV1 {
  version: 1;
  generation: string;
  createdAt: string;
  workspaceId: string;
  auth: {
    cookie: string;
  };
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
}

type UsagePayload = {
  status?: "ok" | "rate-limited";
  usagePercent: number;
  resetInSec: number;
};

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const ALLOWED_HEADERS = new Set(["accept", "content-type"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SourceError("schema", "会话包字段无效：" + field);
  }
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SourceError("schema", "会话包包含未允许字段：" + field);
  }
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!record(value)) {
    throw new SourceError("schema", "会话包字段无效：request.headers");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(normalizedName) || typeof headerValue !== "string") {
      throw new SourceError("schema", "会话包请求头无效");
    }
    headers[normalizedName] = headerValue;
  }
  return headers;
}

export function validateOpenCodeRequest(
  request: OpenCodeSessionBundleV1["request"],
  workspaceId: string
): OpenCodeSessionBundleV1["request"] {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new SourceError("schema", "会话包请求 URL 无效");
  }
  const method = request.method.toUpperCase();
  const workspacePathAllowed = method === "GET" &&
    url.pathname === `/workspace/${encodeURIComponent(workspaceId)}/go` &&
    url.search === "" &&
    url.hash === "";
  if (
    url.protocol !== "https:" ||
    url.hostname !== "opencode.ai" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    !workspacePathAllowed
  ) {
    throw new SourceError("schema", "会话包请求超出允许来源");
  }

  if (method !== "GET") {
    throw new SourceError("schema", "会话包请求方法无效");
  }
  if (method === "GET" && request.body !== undefined) {
    throw new SourceError("schema", "GET 请求不能包含请求体");
  }
  if (
    request.body !== undefined &&
    new TextEncoder().encode(request.body).byteLength > MAX_REQUEST_BODY_BYTES
  ) {
    throw new SourceError("schema", "会话包请求体超过限制");
  }
  const headers = parseHeaders(request.headers);
  return {
    url: url.toString(),
    method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body })
  };
}

export function parseSessionBundle(raw: string): OpenCodeSessionBundleV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SourceError("schema", "会话包不是有效 JSON");
  }
  if (!record(value)) {
    throw new SourceError("schema", "会话包必须是对象");
  }
  assertAllowedKeys(
    value,
    ["version", "generation", "createdAt", "workspaceId", "auth", "request"],
    "根对象"
  );
  if (value.version !== 1) {
    throw new SourceError("schema", "会话包版本不受支持");
  }
  const generation = nonEmptyString(value.generation, "generation");
  const createdAt = nonEmptyString(value.createdAt, "createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new SourceError("schema", "会话包创建时间无效");
  }
  const workspaceId = nonEmptyString(value.workspaceId, "workspaceId");
  if (!record(value.auth)) {
    throw new SourceError("schema", "会话包字段无效：auth");
  }
  assertAllowedKeys(value.auth, ["cookie"], "auth");
  const cookie = nonEmptyString(value.auth.cookie, "auth.cookie");
  if (!/(?:^|;\\s*)auth=/u.test(cookie)) {
    throw new SourceError("schema", "会话包认证 Cookie 无效");
  }
  if (!record(value.request)) {
    throw new SourceError("schema", "会话包字段无效：request");
  }
  assertAllowedKeys(value.request, ["url", "method", "headers", "body"], "request");
  const rawRequest = {
    url: nonEmptyString(value.request.url, "request.url"),
    method: nonEmptyString(value.request.method, "request.method"),
    headers: parseHeaders(value.request.headers),
    ...(value.request.body === undefined
      ? {}
      : { body: nonEmptyString(value.request.body, "request.body") })
  };
  const request = validateOpenCodeRequest(rawRequest, workspaceId);
  return { version: 1, generation, createdAt, workspaceId, auth: { cookie }, request };
}

export function readBundleGeneration(raw: string): string {
  return parseSessionBundle(raw).generation;
}

function isUsagePayload(value: unknown): value is UsagePayload {
  return record(value) &&
    (value.status === undefined || value.status === "ok" || value.status === "rate-limited") &&
    typeof value.usagePercent === "number" &&
    Number.isFinite(value.usagePercent) &&
    value.usagePercent >= 0 &&
    value.usagePercent <= 100 &&
    typeof value.resetInSec === "number" &&
    Number.isFinite(value.resetInSec) &&
    value.resetInSec >= 0;
}

function parseHtmlUsageWindow(
  html: string,
  key: "rollingUsage" | "weeklyUsage" | "monthlyUsage"
): UsagePayload | undefined {
  const assignment = new RegExp(
    `${key}\\s*(?::\\s*\\$R\\[\\d+\\])?\\s*=\\s*\\{([^{}]*)\\}`,
    "u"
  ).exec(html);
  const status = assignment?.[1]
    ? /(?:^|,)\s*status\s*:\s*["'](ok|rate-limited)["']\s*(?:,|$)/u.exec(assignment[1])
    : undefined;
  if (!assignment?.[1] || (status?.[1] !== "ok" && status?.[1] !== "rate-limited")) {
    return undefined;
  }
  const numberSource = "(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
  const reset = new RegExp(
    `(?:^|,)\\s*resetInSec\\s*:\\s*${numberSource}\\s*(?:,|$)`,
    "u"
  ).exec(assignment[1]);
  const usage = new RegExp(
    `(?:^|,)\\s*usagePercent\\s*:\\s*${numberSource}\\s*(?:,|$)`,
    "u"
  ).exec(assignment[1]);
  if (reset?.[1] === undefined || usage?.[1] === undefined) return undefined;
  return {
    status: status[1],
    resetInSec: Number(reset[1]),
    usagePercent: Number(usage[1])
  };
}

export function parseOpenCodeUsageResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const usages = {
      rollingUsage: parseHtmlUsageWindow(text, "rollingUsage"),
      weeklyUsage: parseHtmlUsageWindow(text, "weeklyUsage"),
      monthlyUsage: parseHtmlUsageWindow(text, "monthlyUsage")
    };
    if (!usages.rollingUsage || !usages.weeklyUsage || !usages.monthlyUsage) {
      throw new SourceError("schema", "响应不是有效 JSON 或用量页面");
    }
    return usages;
  }
}

function findUsageWindows(value: unknown): Record<
  "rollingUsage" | "weeklyUsage" | "monthlyUsage",
  UsagePayload
> | undefined {
  if (!record(value)) return undefined;
  if (
    isUsagePayload(value.rollingUsage) &&
    isUsagePayload(value.weeklyUsage) &&
    isUsagePayload(value.monthlyUsage)
  ) {
    return {
      rollingUsage: value.rollingUsage,
      weeklyUsage: value.weeklyUsage,
      monthlyUsage: value.monthlyUsage
    };
  }
  for (const child of Object.values(value)) {
    const found = Array.isArray(child)
      ? child.map(findUsageWindows).find((item) => item !== undefined)
      : findUsageWindows(child);
    if (found) return found;
  }
  return undefined;
}

export function normalizeOpenCodeUsage(
  value: unknown,
  now: Date
): Record<WindowKey, UsageWindow> {
  const usages = findUsageWindows(value);
  if (!usages) {
    throw new SourceError("schema", "响应缺少三个用量窗口");
  }
  const input = {
    rolling: usages.rollingUsage,
    weekly: usages.weeklyUsage,
    monthly: usages.monthlyUsage
  };
  return Object.fromEntries(Object.entries(input).map(([key, usage]) => {
    const resetAt = now.getTime() + usage.resetInSec * 1000;
    if (!Number.isFinite(resetAt)) {
      throw new SourceError("schema", "响应重置时间无效");
    }
    return [key, {
      status: usage.status ?? "ok",
      usedPercent: usage.usagePercent,
      resetAt: new Date(resetAt).toISOString()
    }];
  })) as Record<WindowKey, UsageWindow>;
}

export const OPENCODE_RESPONSE_LIMIT_BYTES = MAX_RESPONSE_BYTES;
