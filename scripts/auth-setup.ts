import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import {
  type OpenCodeRequestDescriptor,
  type OpenCodeSessionBundleV2
} from "../src/opencode-session";
import { OpenCodeConsoleQuotaSource } from "../src/source";
import { OpenCodeUsageListSource } from "../src/opencode-usage-source";
import {
  buildSessionBundle as buildV2SessionBundle,
  buildUsageGetAuthorization,
  OPENCODE_ORIGIN,
  waitBeforeTrigger,
  waitForGoRequest,
  waitForUsageListPage
} from "./opencode-usage-capture";

const AUTH_URL = "https://opencode.ai/auth";
const UPLOAD_SECRET_NAME = "OPENCODE_SESSION_BUNDLE";
const UPLOAD_TIMEOUT_MS = 30_000;
const CAPTURE_NAVIGATION_TIMEOUT_MS = 15_000;
const WORKSPACE_ID = /^wrk_[A-Za-z0-9]+$/u;
const WRANGLER_CLI = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
);

export type UploadChild = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "once" | "off" | "kill"
>;

export type UploadSpawnOptions = {
  stdio: ["pipe", "ignore", "inherit"];
  env?: NodeJS.ProcessEnv;
};

export type UploadDependencies = {
  spawn: (
    command: string,
    args: string[],
    options: UploadSpawnOptions
  ) => UploadChild;
};

export type UploadMode = "deployed" | "version-only";

export type AuthSetupOptions = {
  uploadMode: UploadMode;
  profileDirectory?: string;
  workspaceId?: string;
};

export type UploadOptions = {
  uploadMode?: UploadMode;
  dependencies?: UploadDependencies;
};

export function parseAuthSetupArgs(
  argv: readonly string[]
): AuthSetupOptions {
  let uploadMode: UploadMode = "deployed";
  let profileDirectory: string | undefined;
  let workspaceId: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || seen.has(argument)) {
      throw new Error("授权参数重复或无效");
    }
    if (argument === "--version-only") {
      seen.add(argument);
      uploadMode = "version-only";
      continue;
    }
    if (argument === "--profile") {
      seen.add(argument);
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw new Error("--profile 必须提供浏览器资料目录");
      }
      profileDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--workspace") {
      seen.add(argument);
      const value = argv[index + 1];
      if (value === undefined || !WORKSPACE_ID.test(value)) {
        throw new Error("--workspace 必须是有效的工作区 ID");
      }
      workspaceId = value;
      index += 1;
      continue;
    }
    throw new Error("仅支持 --version-only、--profile 和 --workspace 参数");
  }
  if (workspaceId !== undefined && profileDirectory === undefined) {
    throw new Error("--workspace 只能与 --profile 一起使用");
  }
  return {
    uploadMode,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
    ...(workspaceId === undefined ? {} : { workspaceId })
  };
}

export function buildWranglerSecretArgs(
  wranglerCli: string,
  mode: UploadMode
): string[] {
  return mode === "version-only"
    ? [wranglerCli, "versions", "secret", "put", UPLOAD_SECRET_NAME]
    : [wranglerCli, "secret", "put", UPLOAD_SECRET_NAME];
}

export function workspaceIdFromPageUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== OPENCODE_ORIGIN) return undefined;
    const match = /^\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/u.exec(parsed.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function workspaceUsageUrl(workspaceId: string): string {
  return `${OPENCODE_ORIGIN}/workspace/${encodeURIComponent(workspaceId)}/usage`;
}

export async function navigateWithinOpenCodeApp(
  page: Pick<Page, "evaluate">,
  targetUrl: string,
  signal: AbortSignal
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("SPA 导航目标 URL 无效");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "opencode.ai" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/workspace\/wrk_[A-Za-z0-9]+\/usage$/u.test(parsed.pathname)
  ) {
    throw new Error("SPA 导航目标必须是同源的精确 usage 路径");
  }
  signal.throwIfAborted();
  await page.evaluate((href) => {
    const browserDocument = (globalThis as unknown as {
      document: {
        createElement(tag: "a"): {
          href: string;
          hidden: boolean;
          setAttribute(name: string, value: string): void;
          click(): void;
          remove(): void;
        };
        body: { append(node: unknown): void };
      };
    }).document;
    const anchor = browserDocument.createElement("a");
    anchor.href = href;
    anchor.hidden = true;
    anchor.setAttribute("link", "");
    browserDocument.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  }, parsed.href);
  signal.throwIfAborted();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("授权已取消");
}

async function launchVisibleContext(profileDirectory: string): Promise<BrowserContext> {
  let lastError: unknown;
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await chromium.launchPersistentContext(profileDirectory, {
        channel,
        headless: false
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

type CandidatePause = (signal: AbortSignal) => Promise<void>;

async function pauseBeforeCandidateCheck(signal: AbortSignal): Promise<void> {
  try {
    await delay(500, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw error;
  }
}

type PageUrlContext = Pick<BrowserContext, "pages">;
type NewPageContext = Pick<BrowserContext, "newPage">;
type CookieContext = Pick<BrowserContext, "cookies">;

export async function openAuthenticationPage(
  context: NewPageContext,
  signal: AbortSignal
): Promise<Page> {
  signal.throwIfAborted();
  const page = await context.newPage();
  signal.throwIfAborted();
  await page.goto(AUTH_URL, {
    signal,
    timeout: CAPTURE_NAVIGATION_TIMEOUT_MS,
    waitUntil: "commit"
  });
  return page;
}

export async function waitForWorkspaceId(
  context: PageUrlContext,
  signal: AbortSignal,
  pause: CandidatePause = pauseBeforeCandidateCheck
): Promise<string> {
  while (true) {
    signal.throwIfAborted();
    for (const page of context.pages()) {
      const workspaceId = workspaceIdFromPageUrl(page.url());
      if (workspaceId) return workspaceId;
    }
    await pause(signal);
  }
}

export function resolveProfileWorkspaceId(
  context: PageUrlContext,
  requested?: string
): string {
  if (requested !== undefined) {
    if (!WORKSPACE_ID.test(requested)) throw new Error("工作区 ID 无效");
    return requested;
  }
  const workspaceIds = new Set<string>();
  for (const page of context.pages()) {
    const workspaceId = workspaceIdFromPageUrl(page.url());
    if (workspaceId) workspaceIds.add(workspaceId);
  }
  if (workspaceIds.size === 1) return [...workspaceIds][0] as string;
  throw new Error("复用浏览器资料时无法唯一识别工作区，请通过 --workspace 指定");
}

export async function requireOpenCodeAuthCookie(
  context: CookieContext
): Promise<string> {
  const authCookieValue = await readOpenCodeAuthCookie(context);
  if (authCookieValue === undefined) throw new Error("未检测到 OpenCode auth Cookie");
  return authCookieValue;
}

export async function readOpenCodeAuthCookie(
  context: CookieContext
): Promise<string | undefined> {
  const authCookie = (await context.cookies(OPENCODE_ORIGIN)).find(
    (cookie) => cookie.name === "auth" && cookie.value.length > 0
  );
  return authCookie?.value;
}

export async function waitForOpenCodeAuthCookie(
  context: CookieContext,
  signal: AbortSignal,
  pause: CandidatePause = pauseBeforeCandidateCheck
): Promise<string> {
  while (true) {
    signal.throwIfAborted();
    const authCookieValue = await readOpenCodeAuthCookie(context);
    if (authCookieValue !== undefined) return authCookieValue;
    await pause(signal);
  }
}

export async function resolveReusableProfile(
  context: PageUrlContext & CookieContext,
  requestedWorkspaceId?: string
): Promise<{ workspaceId: string; authCookieValue: string }> {
  const authCookieValue = await requireOpenCodeAuthCookie(context);
  const workspaceId = resolveProfileWorkspaceId(context, requestedWorkspaceId);
  return { workspaceId, authCookieValue };
}

export async function preparePersistentProfileAuthorization(
  context: PageUrlContext & CookieContext & NewPageContext,
  requestedWorkspaceId: string | undefined,
  signal: AbortSignal,
  onLoginRequired: () => void = () => undefined
): Promise<{
  workspaceId: string;
  authCookieValue: string;
  reusedExistingSession: boolean;
}> {
  signal.throwIfAborted();
  const existingAuthCookieValue = await readOpenCodeAuthCookie(context);
  if (existingAuthCookieValue !== undefined) {
    return {
      workspaceId: resolveProfileWorkspaceId(context, requestedWorkspaceId),
      authCookieValue: existingAuthCookieValue,
      reusedExistingSession: true
    };
  }

  await openAuthenticationPage(context, signal);
  signal.throwIfAborted();
  onLoginRequired();
  const authCookieValue = await waitForOpenCodeAuthCookie(context, signal);
  let workspaceId: string;
  if (requestedWorkspaceId === undefined) {
    await waitForWorkspaceId(context, signal);
    workspaceId = resolveProfileWorkspaceId(context);
  } else {
    workspaceId = resolveProfileWorkspaceId(context, requestedWorkspaceId);
  }
  return { workspaceId, authCookieValue, reusedExistingSession: false };
}

type GoRequestWaiter = (
  page: Page,
  workspaceId: string,
  signal: AbortSignal
) => Promise<OpenCodeRequestDescriptor>;

export async function captureGoAuthorization(
  context: NewPageContext,
  workspaceId: string,
  signal: AbortSignal,
  waitForRequest: GoRequestWaiter = waitForGoRequest
): Promise<{ page: Page; goRequest: OpenCodeRequestDescriptor }> {
  signal.throwIfAborted();
  const page = await context.newPage();
  signal.throwIfAborted();
  const goRequest = await waitBeforeTrigger(
    signal,
    (waiterSignal) => waitForRequest(page, workspaceId, waiterSignal),
    (triggerSignal) => page.goto(
      `${OPENCODE_ORIGIN}/workspace/${workspaceId}/go`,
      {
        signal: triggerSignal,
        timeout: CAPTURE_NAVIGATION_TIMEOUT_MS,
        waitUntil: "commit"
      }
    ).then(() => undefined)
  );
  return { page, goRequest };
}

export { buildV2SessionBundle as buildSessionBundle };

type BrowserProfile = Pick<BrowserContext, "close">;
type ProfileRemover = (directory: string) => Promise<void>;

export async function cleanUpBrowserProfile(
  context: BrowserProfile | undefined,
  profileDirectory: string,
  removeProfile: ProfileRemover = (directory) => rm(directory, { recursive: true, force: true }),
  removeDirectory = true
): Promise<void> {
  try {
    await context?.close();
  } finally {
    if (removeDirectory) await removeProfile(profileDirectory);
  }
}

async function collectSessionBundle(
  signal: AbortSignal,
  options: Pick<AuthSetupOptions, "profileDirectory" | "workspaceId"> = {}
): Promise<OpenCodeSessionBundleV2> {
  const providedProfile = options.profileDirectory;
  const ownsProfile = providedProfile === undefined;
  const profileDirectory = providedProfile === undefined
    ? await mkdtemp(join(tmpdir(), "opencode-auth-"))
    : resolve(providedProfile);
  let context: BrowserContext | undefined;
  try {
    signal.throwIfAborted();
    context = await launchVisibleContext(profileDirectory);
    signal.throwIfAborted();
    let workspaceId: string;
    let authCookieValue: string;
    if (ownsProfile) {
      await openAuthenticationPage(context, signal);
      console.log(
        "请在打开的浏览器中完成 GitHub 登录并进入目标工作区；工具会自动打开用量页并继续。"
      );
      workspaceId = await waitForWorkspaceId(context, signal);
      authCookieValue = await requireOpenCodeAuthCookie(context);
    } else {
      const persistentProfile = await preparePersistentProfileAuthorization(
        context,
        options.workspaceId,
        signal,
        () => console.log(
          "请完成一次 GitHub 登录并进入任一工作区；登录状态会保留在指定的浏览器资料目录。"
        )
      );
      workspaceId = persistentProfile.workspaceId;
      authCookieValue = persistentProfile.authCookieValue;
      console.log(
        persistentProfile.reusedExistingSession
          ? "授权阶段：已复用现有登录资料"
          : "授权阶段：首次登录状态已保留"
      );
    }
    signal.throwIfAborted();
    console.log("授权阶段：已识别工作区，开始捕获 go");
    const { page, goRequest } = await captureGoAuthorization(
      context,
      workspaceId,
      signal
    );
    console.log("授权阶段：go 已捕获，开始捕获 usage 第 0 页");
    const page0 = await waitBeforeTrigger(
      signal,
      (waiterSignal) => waitForUsageListPage(page, workspaceId, 0, waiterSignal),
      (triggerSignal) => navigateWithinOpenCodeApp(
        page,
        workspaceUsageUrl(workspaceId),
        triggerSignal
      )
    );
    console.log("授权阶段：usage 第 0 页已捕获");
    const usageList = buildUsageGetAuthorization(
      page0.request,
      workspaceId,
      page0.records.length
    );
    signal.throwIfAborted();
    const bundle = buildV2SessionBundle(workspaceId, authCookieValue, goRequest, usageList);
    console.log("授权阶段：会话包已生成，开始真实回放");
    const replay = await new OpenCodeUsageListSource(bundle).fetch(Date.now());
    if (replay.status === "unavailable") {
      throw new Error("usage.list 回放验证未通过");
    }
    return bundle;
  } finally {
    await cleanUpBrowserProfile(
      context,
      profileDirectory,
      (directory) => rm(directory, { recursive: true, force: true }),
      ownsProfile
    );
  }
}

export async function uploadSessionBundle(
  sessionBundle: string,
  signal: AbortSignal,
  options: UploadDependencies | UploadOptions = {
    spawn: (command, args, options) =>
      spawn(command, args, options) as unknown as UploadChild
  }
): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  const dependencies: UploadDependencies = "spawn" in options
    ? options
    : options.dependencies ?? {
        spawn: (command, args, spawnOptions) =>
          spawn(command, args, spawnOptions) as unknown as UploadChild
      };
  const uploadMode: UploadMode = "spawn" in options
    ? "deployed"
    : options.uploadMode ?? "deployed";
  const command = process.execPath;
  await new Promise<void>((resolveUpload, rejectUpload) => {
    let child: UploadChild;
    try {
      child = dependencies.spawn(command, buildWranglerSecretArgs(WRANGLER_CLI, uploadMode), {
        stdio: ["pipe", "ignore", "inherit"]
      });
    } catch {
      rejectUpload(new Error("无法启动 Secret 上传命令"));
      return;
    }
    let settled = false;
    let cancellation: Error | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const onError = () => fail(new Error("Secret 上传命令执行失败"));
    const onStdinError = () => fail(new Error("Secret 上传输入失败"));
    const onClose = (code: number | null) => {
      if (cancellation) settle(cancellation);
      else if (code === 0) settle();
      else settle(new Error("Secret 上传失败"));
    };
    const onAbort = () => {
      if (settled || cancellation) return;
      cancellation = abortError(signal);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {
        // close 事件才代表子进程生命周期结束，取消结果在该事件后结算。
      }
    };
    const cleanUp = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdin.off("error", onStdinError);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanUp();
      if (error) rejectUpload(error);
      else resolveUpload();
    };
    const fail = (error: Error) => {
      if (settled || cancellation) return;
      try {
        child.kill();
      } finally {
        settle(error);
      }
    };
    timer = setTimeout(() => fail(new Error("Secret 上传超时")), UPLOAD_TIMEOUT_MS);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.once("error", onStdinError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      child.stdin.end(sessionBundle, "utf8");
    } catch {
      fail(new Error("Secret 上传输入失败"));
    }
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("授权已取消"));
  process.on("SIGINT", onSigint);
  try {
    const { uploadMode, profileDirectory, workspaceId } = parseAuthSetupArgs(
      process.argv.slice(2)
    );
    const bundle = await collectSessionBundle(controller.signal, {
      ...(profileDirectory === undefined ? {} : { profileDirectory }),
      ...(workspaceId === undefined ? {} : { workspaceId })
    });
    controller.signal.throwIfAborted();
    const snapshot = await new OpenCodeConsoleQuotaSource(bundle).fetch(new Date());
    controller.signal.throwIfAborted();
    console.log([
      snapshot.windows.rolling.usedPercent,
      snapshot.windows.weekly.usedPercent,
      snapshot.windows.monthly.usedPercent
    ].map((percent) => `${percent}%`).join("\n"));
    console.log("授权阶段：真实回放通过，开始上传");
    await uploadSessionBundle(JSON.stringify(bundle), controller.signal, { uploadMode });
    console.log("授权阶段：上传完成");
  } finally {
    process.off("SIGINT", onSigint);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("授权失败，请关闭浏览器后重新运行该命令。");
    process.exitCode = 1;
  });
}
