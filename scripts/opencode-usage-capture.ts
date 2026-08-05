import { randomUUID } from "node:crypto";

import type { Page, Response } from "playwright-core";

import {
  parseSessionBundle,
  parseOpenCodeGoResponse,
  validateUsageListRequestDescriptor,
  type OpenCodeRequestDescriptor,
  type OpenCodeSessionBundleV2,
  type UsagePageNumberTemplate
} from "../src/opencode-session";
import { parseUsageListPage } from "../src/opencode-usage";

export const OPENCODE_ORIGIN = "https://opencode.ai";
const MAX_CAPTURE_BYTES = 512 * 1024;

export interface RawCapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface CapturedUsagePage {
  request: OpenCodeRequestDescriptor;
  records: ReturnType<typeof parseUsageListPage>;
}

type WaiterResult<T> =
  | { state: "fulfilled"; value: T }
  | { state: "rejected"; error: unknown };

/** 先登记 waiter，再执行触发动作；触发失败时回收 waiter 的拒绝。 */
export async function waitBeforeTrigger<T>(
  externalSignal: AbortSignal,
  startWaiter: (signal: AbortSignal) => Promise<T>,
  trigger: (signal: AbortSignal) => Promise<void>
): Promise<T> {
  externalSignal.throwIfAborted();
  const controller = new AbortController();
  const forwardExternalAbort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", forwardExternalAbort, { once: true });
  if (externalSignal.aborted) forwardExternalAbort();

  let waiter: Promise<T>;
  try {
    waiter = startWaiter(controller.signal);
  } catch (error) {
    controller.abort(error);
    externalSignal.removeEventListener("abort", forwardExternalAbort);
    throw error;
  }
  const settledWaiter: Promise<WaiterResult<T>> = waiter.then(
    (value) => ({ state: "fulfilled", value }),
    (error: unknown) => ({ state: "rejected", error })
  );

  try {
    controller.signal.throwIfAborted();
    await trigger(controller.signal);
    const result = await settledWaiter;
    if (result.state === "rejected") throw result.error;
    return result.value;
  } catch (error) {
    controller.abort(error);
    await settledWaiter;
    throw error;
  } finally {
    controller.abort();
    externalSignal.removeEventListener("abort", forwardExternalAbort);
  }
}

function requireCaptureSize(value: string | Buffer, description: string): void {
  if (Buffer.byteLength(value) > MAX_CAPTURE_BYTES) {
    throw new Error(`${description}超过 512 KiB 限制`);
  }
}

/** 只保留回放所需的请求信息，绝不读取 request.allHeaders()。 */
export function minimizeCapturedRequest(raw: RawCapturedRequest): OpenCodeRequestDescriptor {
  if (raw.body !== undefined) requireCaptureSize(raw.body, "捕获请求体");
  const headers: Record<string, string> = {};
  const accept = raw.headers.accept;
  if (typeof accept === "string") headers.accept = accept;
  const contentType = raw.headers["content-type"];
  if (raw.body !== undefined && typeof contentType === "string") {
    headers["content-type"] = contentType;
  }
  return {
    url: raw.url,
    method: raw.method,
    headers,
    ...(raw.body === undefined ? {} : { body: raw.body })
  };
}

export function deriveUniqueZeroToOneTemplate(
  zero: string,
  one: string
): { prefix: string; suffix: string } {
  let start = 0;
  while (start < zero.length && start < one.length && zero[start] === one[start]) {
    start += 1;
  }
  let zeroEnd = zero.length;
  let oneEnd = one.length;
  while (zeroEnd > start && oneEnd > start && zero[zeroEnd - 1] === one[oneEnd - 1]) {
    zeroEnd -= 1;
    oneEnd -= 1;
  }
  if (zero.slice(start, zeroEnd) !== "0" || one.slice(start, oneEnd) !== "1") {
    throw new Error("无法唯一定位 usage.list 页号");
  }
  return { prefix: zero.slice(0, start), suffix: zero.slice(zeroEnd) };
}

function sameHeaders(
  zero: Record<string, string>,
  one: Record<string, string>
): boolean {
  const zeroEntries = Object.entries(zero).sort(([left], [right]) => left.localeCompare(right));
  const oneEntries = Object.entries(one).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(zeroEntries) === JSON.stringify(oneEntries);
}

/**
 * 仅当第 0/1 页在 URL 或请求体的一个字符位置上从 0 变为 1 时才生成模板。
 */
export function deriveUsagePageNumberTemplate(
  page0: OpenCodeRequestDescriptor,
  page1: OpenCodeRequestDescriptor
): UsagePageNumberTemplate {
  if (page0.method !== page1.method || !sameHeaders(page0.headers, page1.headers)) {
    throw new Error("usage.list 分页请求的方法或请求头发生变化");
  }
  const urlChanged = page0.url !== page1.url;
  const bodyChanged = page0.body !== page1.body;
  if (urlChanged === bodyChanged) {
    throw new Error("usage.list 分页请求只能有一个页号差异");
  }
  if (urlChanged) {
    const zeroUrl = new URL(page0.url);
    const oneUrl = new URL(page1.url);
    if (
      zeroUrl.protocol !== oneUrl.protocol ||
      zeroUrl.hostname !== oneUrl.hostname ||
      zeroUrl.port !== oneUrl.port ||
      zeroUrl.pathname !== oneUrl.pathname
    ) {
      throw new Error("usage.list 分页请求的固定 URL 部分发生变化");
    }
    return { location: "url", ...deriveUniqueZeroToOneTemplate(page0.url, page1.url) };
  }
  if (page0.body === undefined || page1.body === undefined) {
    throw new Error("usage.list 分页请求体缺失");
  }
  return { location: "body", ...deriveUniqueZeroToOneTemplate(page0.body, page1.body) };
}

export function buildUsageGetAuthorization(
  firstPage: OpenCodeRequestDescriptor,
  workspaceId: string,
  recordCount: number
): OpenCodeSessionBundleV2["usageList"] {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > 50) {
    throw new Error("usage 第 0 页记录数量必须在 0 到 50 之间");
  }
  const validatedFirstPage = validateUsageListRequestDescriptor(firstPage, workspaceId, 0);
  const firstUrl = new URL(validatedFirstPage.url);
  const firstArgs = firstUrl.searchParams.get("args");
  if (firstArgs === null) throw new Error("usage 第 0 页缺少 args");

  const graph = JSON.parse(firstArgs) as {
    t: { a: [unknown, Record<string, unknown>] };
  };
  firstUrl.searchParams.set("args", JSON.stringify(graph));
  const canonicalFirstPage = validateUsageListRequestDescriptor(
    { ...validatedFirstPage, url: firstUrl.toString() },
    workspaceId,
    0
  );
  if (recordCount < 50) {
    return { firstPage: canonicalFirstPage, pagination: { mode: "single-page" } };
  }

  const pageOneGraph = {
    ...graph,
    t: {
      ...graph.t,
      a: [graph.t.a[0], { ...graph.t.a[1], s: 1 }] as [unknown, Record<string, unknown>]
    }
  };
  const pageOneUrl = new URL(canonicalFirstPage.url);
  pageOneUrl.searchParams.set("args", JSON.stringify(pageOneGraph));
  const pageOne = validateUsageListRequestDescriptor(
    { ...canonicalFirstPage, url: pageOneUrl.toString() },
    workspaceId,
    1
  );
  return {
    firstPage: canonicalFirstPage,
    pagination: {
      mode: "paginated",
      template: deriveUsagePageNumberTemplate(canonicalFirstPage, pageOne)
    }
  };
}

export function buildSessionBundle(
  workspaceId: string,
  authCookie: string,
  goRequest: OpenCodeRequestDescriptor,
  usageList: OpenCodeSessionBundleV2["usageList"]
): OpenCodeSessionBundleV2 {
  const bundle = parseSessionBundle(JSON.stringify({
    version: 2,
    generation: randomUUID(),
    createdAt: new Date().toISOString(),
    workspaceId,
    auth: { cookie: `auth=${authCookie}` },
    goRequest,
    usageList
  }));
  if (bundle.version !== 2) throw new Error("生成的会话包版本无效");
  return bundle;
}

function isSameOrigin(response: Response): boolean {
  try {
    return new URL(response.url()).origin === OPENCODE_ORIGIN;
  } catch {
    return false;
  }
}

export function hasValidUsageServerHeaders(
  url: URL,
  headers: Record<string, string>
): boolean {
  const id = url.searchParams.get("id");
  return id !== null &&
    headers["x-server-id"] === id &&
    /^server-fn:[0-9]+$/u.test(headers["x-server-instance"] ?? "");
}

function requestFromResponse(response: Response): OpenCodeRequestDescriptor {
  const request = response.request();
  const body = request.postData();
  return minimizeCapturedRequest({
    url: request.url(),
    method: request.method(),
    headers: request.headers(),
    ...(body === null ? {} : { body })
  });
}

async function responseTextWithinLimit(response: Response): Promise<string> {
  const body = await response.body();
  requireCaptureSize(body, "捕获响应体");
  return body.toString("utf8");
}

export async function waitForGoRequest(
  page: Page,
  workspaceId: string,
  signal: AbortSignal
): Promise<OpenCodeRequestDescriptor> {
  const expectedPath = `/workspace/${encodeURIComponent(workspaceId)}/go`;
  const response = await page.waitForResponse(async (candidate) => {
    if (!candidate.ok() || !isSameOrigin(candidate)) return false;
    if (new URL(candidate.url()).pathname !== expectedPath) return false;
    try {
      parseOpenCodeGoResponse(await responseTextWithinLimit(candidate));
      return true;
    } catch {
      return false;
    }
  }, { timeout: 30_000, signal });
  return requestFromResponse(response);
}

export async function waitForUsageListPage(
  page: Page,
  workspaceId: string,
  expectedPage: number,
  signal: AbortSignal,
  accept: (candidate: CapturedUsagePage) => boolean = () => true
): Promise<CapturedUsagePage> {
  let accepted: CapturedUsagePage | undefined;
  await page.waitForResponse(async (response) => {
    if (!response.ok() || !isSameOrigin(response)) return false;
    const rawRequest = response.request();
    let url: URL;
    try {
      url = new URL(rawRequest.url());
    } catch {
      return false;
    }
    const method = rawRequest.method().toUpperCase();
    if (url.pathname !== "/_server" || method !== "GET") {
      return false;
    }
    if (!hasValidUsageServerHeaders(url, rawRequest.headers())) return false;
    try {
      const request = validateUsageListRequestDescriptor(
        requestFromResponse(response),
        workspaceId,
        expectedPage
      );
      const text = await responseTextWithinLimit(response);
      const candidate = {
        request,
        records: parseUsageListPage(text, response.headers()["content-type"] ?? "")
      };
      if (!accept(candidate)) return false;
      accepted = candidate;
      return true;
    } catch {
      return false;
    }
  }, { timeout: 30_000, signal });
  if (!accepted) throw new Error("未捕获到有效的 usage.list 响应");
  return accepted;
}
