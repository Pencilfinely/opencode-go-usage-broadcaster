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

export interface OpenCodeRequestDescriptor {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type UsagePageNumberTemplate =
  | { location: "url"; prefix: string; suffix: string }
  | { location: "body"; prefix: string; suffix: string };

export type UsagePaginationAuthorization =
  | { mode: "single-page" }
  | { mode: "paginated"; template: UsagePageNumberTemplate };

export interface OpenCodeSessionBundleV2 {
  version: 2;
  generation: string;
  createdAt: string;
  workspaceId: string;
  auth: { cookie: string };
  goRequest: OpenCodeRequestDescriptor;
  usageList: {
    firstPage: OpenCodeRequestDescriptor;
    pagination: UsagePaginationAuthorization;
  };
}

export type OpenCodeSessionBundle = OpenCodeSessionBundleV1 | OpenCodeSessionBundleV2;

type UsagePayload = {
  status?: "ok" | "rate-limited";
  usagePercent: number;
  resetInSec: number;
};

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
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
    if (
      !ALLOWED_HEADERS.has(normalizedName) ||
      typeof headerValue !== "string" || headers[normalizedName] !== undefined
    ) {
      throw new SourceError("schema", "会话包请求头无效");
    }
    headers[normalizedName] = headerValue;
  }
  return headers;
}

function parseRequestDescriptor(value: unknown, field: string): OpenCodeRequestDescriptor {
  if (!record(value)) {
    throw new SourceError("schema", "会话包字段无效：" + field);
  }
  assertAllowedKeys(value, ["url", "method", "headers", "body"], field);
  return {
    url: nonEmptyString(value.url, field + ".url"),
    method: nonEmptyString(value.method, field + ".method"),
    headers: parseHeaders(value.headers),
    ...(value.body === undefined ? {} : { body: nonEmptyString(value.body, field + ".body") })
  };
}

export function validateOpenCodeGoRequest(
  request: OpenCodeRequestDescriptor,
  workspaceId: string
): OpenCodeRequestDescriptor {
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

/** 保留旧名以避免现有调用方失效。 */
export const validateOpenCodeRequest = validateOpenCodeGoRequest;

function validateUsageOrigin(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "opencode.ai" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash !== ""
  ) {
    throw new SourceError("schema", "usage.list 请求超出允许来源");
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function findUsageParameters(source: string, workspaceId: string, expectedPage: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return false;
  }
  const parameters = parseSerovalUsageParameters(parsed);
  if (!parameters) return false;
  if (parameters[0] !== workspaceId || parameters[1] !== expectedPage) {
    throw new SourceError("schema", "usage.list 请求参数无效");
  }
  return true;
}

function parseSerovalUsageParameters(value: unknown): unknown[] | undefined {
  if (!record(value) || !hasExactKeys(value, ["t", "f", "m"]) || !record(value.t)) {
    return undefined;
  }
  if (value.f !== 31 || !Array.isArray(value.m) || value.m.length !== 0) return undefined;
  const root = value.t;
  if (
    !hasExactKeys(root, ["t", "i", "l", "a", "o"]) ||
    root.t !== 9 ||
    root.i !== 0 ||
    root.l !== 2 ||
    root.o !== 0 ||
    !Array.isArray(root.a) ||
    root.a.length !== 2
  ) {
    return undefined;
  }
  const [workspace, page] = root.a;
  if (
    !record(workspace) || !hasExactKeys(workspace, ["t", "s"]) ||
    workspace.t !== 1 || typeof workspace.s !== "string" ||
    !record(page) || !hasExactKeys(page, ["t", "s"]) ||
    page.t !== 0 || typeof page.s !== "number" ||
    !Number.isSafeInteger(page.s) || page.s < 0
  ) {
    return undefined;
  }
  return [workspace.s, page.s];
}

export function validateUsageListRequestDescriptor(
  request: OpenCodeRequestDescriptor,
  workspaceId: string,
  expectedPage: number
): OpenCodeRequestDescriptor {
  if (!Number.isSafeInteger(expectedPage) || expectedPage < 0) {
    throw new SourceError("schema", "usage.list 页号无效");
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new SourceError("schema", "usage.list 请求 URL 无效");
  }
  validateUsageOrigin(url);
  const method = request.method.toUpperCase();
  if (url.pathname !== "/_server" || method !== "GET") {
    throw new SourceError("schema", "usage.list 请求方法无效");
  }
  const headers = parseHeaders(request.headers);
  if (request.body !== undefined) {
    throw new SourceError("schema", "GET 请求不能包含请求体");
  }
  const idValues = url.searchParams.getAll("id");
  const argsValues = url.searchParams.getAll("args");
  const id = idValues[0];
  const args = argsValues[0];
  if (
    url.searchParams.size !== 2 ||
    idValues.length !== 1 ||
    argsValues.length !== 1 ||
    id === undefined ||
    args === undefined ||
    !/^[a-f0-9]{64}$/u.test(id) ||
    !findUsageParameters(args, workspaceId, expectedPage)
  ) {
    throw new SourceError("schema", "usage.list 请求参数不唯一");
  }
  return {
    url: url.toString(),
    method,
    headers
  };
}

export function renderUsagePageRequest(
  firstPage: OpenCodeRequestDescriptor,
  template: UsagePageNumberTemplate,
  page: number
): OpenCodeRequestDescriptor {
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new SourceError("schema", "usage.list 页号无效");
  }
  const rendered = template.prefix + String(page) + template.suffix;
  return template.location === "url"
    ? { ...firstPage, url: rendered }
    : { ...firstPage, body: rendered };
}

function parsePagination(
  value: unknown,
  firstPage: OpenCodeRequestDescriptor,
  workspaceId: string
): UsagePaginationAuthorization {
  if (!record(value)) throw new SourceError("schema", "会话包字段无效：usageList.pagination");
  if (value.mode === "single-page") {
    assertAllowedKeys(value, ["mode"], "usageList.pagination");
    return { mode: "single-page" };
  }
  if (value.mode !== "paginated") {
    throw new SourceError("schema", "usage.list 分页模式无效");
  }
  assertAllowedKeys(value, ["mode", "template"], "usageList.pagination");
  if (!record(value.template)) throw new SourceError("schema", "会话包字段无效：usageList.pagination.template");
  assertAllowedKeys(value.template, ["location", "prefix", "suffix"], "usageList.pagination.template");
  const location = value.template.location;
  if (location !== "url" && location !== "body") {
    throw new SourceError("schema", "usage.list 页号位置无效");
  }
  const template: UsagePageNumberTemplate = {
    location,
    prefix: nonEmptyString(value.template.prefix, "usageList.pagination.template.prefix"),
    suffix: nonEmptyString(value.template.suffix, "usageList.pagination.template.suffix")
  };
  if (location === "url") {
    const queryStart = template.prefix.indexOf("?");
    const fragmentStart = template.prefix.indexOf("#");
    if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < template.prefix.length)) {
      throw new SourceError("schema", "usage.list 页号必须位于查询参数");
    }
  }
  const zeroPage = renderUsagePageRequest(firstPage, template, 0);
  if (zeroPage.url !== firstPage.url || zeroPage.body !== firstPage.body) {
    throw new SourceError("schema", "usage.list 分页模板与首页不一致");
  }
  validateUsageListRequestDescriptor(
    renderUsagePageRequest(firstPage, template, 1),
    workspaceId,
    1
  );
  return { mode: "paginated", template };
}

export function parseSessionBundle(raw: string): OpenCodeSessionBundle {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SourceError("schema", "会话包不是有效 JSON");
  }
  if (!record(value)) {
    throw new SourceError("schema", "会话包必须是对象");
  }
  if (value.version !== 1 && value.version !== 2) {
    throw new SourceError("schema", "会话包版本不受支持");
  }
  assertAllowedKeys(
    value,
    value.version === 1
      ? ["version", "generation", "createdAt", "workspaceId", "auth", "request"]
      : ["version", "generation", "createdAt", "workspaceId", "auth", "goRequest", "usageList"],
    "根对象"
  );
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
  if (value.version === 1) {
    const request = validateOpenCodeGoRequest(parseRequestDescriptor(value.request, "request"), workspaceId);
    return { version: 1, generation, createdAt, workspaceId, auth: { cookie }, request };
  }
  if (!record(value.usageList)) {
    throw new SourceError("schema", "会话包字段无效：usageList");
  }
  assertAllowedKeys(value.usageList, ["firstPage", "pagination"], "usageList");
  const goRequest = validateOpenCodeGoRequest(
    parseRequestDescriptor(value.goRequest, "goRequest"),
    workspaceId
  );
  const firstPage = validateUsageListRequestDescriptor(
    parseRequestDescriptor(value.usageList.firstPage, "usageList.firstPage"),
    workspaceId,
    0
  );
  const pagination = parsePagination(value.usageList.pagination, firstPage, workspaceId);
  return {
    version: 2,
    generation,
    createdAt,
    workspaceId,
    auth: { cookie },
    goRequest,
    usageList: { firstPage, pagination }
  };
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

export function parseOpenCodeGoResponse(text: string): unknown {
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
