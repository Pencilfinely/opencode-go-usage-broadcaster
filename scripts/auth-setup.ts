import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright-core";

import { type OpenCodeSessionBundleV2 } from "../src/opencode-session";
import { OpenCodeConsoleQuotaSource } from "../src/source";
import { OpenCodeUsageListSource } from "../src/opencode-usage-source";
import {
  buildSessionBundle as buildV2SessionBundle,
  deriveUsagePageNumberTemplate,
  OPENCODE_ORIGIN,
  waitBeforeTrigger,
  waitForGoRequest,
  waitForUsageListPage
} from "./opencode-usage-capture";

const AUTH_URL = "https://opencode.ai/auth";
const UPLOAD_SECRET_NAME = "OPENCODE_SESSION_BUNDLE";
const UPLOAD_TIMEOUT_MS = 30_000;
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

export type UploadOptions = {
  uploadMode?: UploadMode;
  dependencies?: UploadDependencies;
};

export function parseAuthSetupArgs(
  argv: readonly string[]
): { uploadMode: UploadMode } {
  if (argv.length === 0) return { uploadMode: "deployed" };
  if (argv.length === 1 && argv[0] === "--version-only") {
    return { uploadMode: "version-only" };
  }
  throw new Error("仅支持可选参数 --version-only");
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

export { buildV2SessionBundle as buildSessionBundle };

type BrowserProfile = Pick<BrowserContext, "close">;
type ProfileRemover = (directory: string) => Promise<void>;

export async function cleanUpBrowserProfile(
  context: BrowserProfile | undefined,
  profileDirectory: string,
  removeProfile: ProfileRemover = (directory) => rm(directory, { recursive: true, force: true })
): Promise<void> {
  try {
    await context?.close();
  } finally {
    await removeProfile(profileDirectory);
  }
}

async function collectSessionBundle(signal: AbortSignal): Promise<OpenCodeSessionBundleV2> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  let context: BrowserContext | undefined;
  try {
    signal.throwIfAborted();
    context = await launchVisibleContext(profileDirectory);
    signal.throwIfAborted();
    const page = await context.newPage();
    await page.goto(AUTH_URL);
    console.log(
      "请在打开的浏览器中完成 GitHub 登录并进入目标工作区；工具会自动打开用量页并继续。"
    );

    const workspaceId = await waitForWorkspaceId(context, signal);
    signal.throwIfAborted();
    const goRequest = await waitBeforeTrigger(
      signal,
      (waiterSignal) => waitForGoRequest(page, workspaceId, waiterSignal),
      (triggerSignal) => page.goto(
        `${OPENCODE_ORIGIN}/workspace/${workspaceId}/go`,
        { signal: triggerSignal }
      ).then(() => undefined)
    );
    const authCookie = (await context.cookies(OPENCODE_ORIGIN)).find(
      (cookie) => cookie.name === "auth"
    );
    if (!authCookie) {
      throw new Error("已识别工作区，但未检测到 OpenCode auth Cookie");
    }
    const page0 = await waitBeforeTrigger(
      signal,
      (waiterSignal) => waitForUsageListPage(page, waiterSignal),
      (triggerSignal) => page.goto(workspaceUsageUrl(workspaceId), { signal: triggerSignal })
        .then(() => undefined)
    );
    const usageList: OpenCodeSessionBundleV2["usageList"] = page0.records.length < 50
      ? { firstPage: page0.request, pagination: { mode: "single-page" } }
      : await (async () => {
          const paginationButtons = page.locator(
            '[data-slot="usage-table"] [data-slot="pagination"] > button'
          );
          if (await paginationButtons.count() !== 2) {
            throw new Error("未找到唯一的 usage 分页控件");
          }
          const page1 = await waitBeforeTrigger(
            signal,
            (waiterSignal) => waitForUsageListPage(
              page,
              waiterSignal,
              (candidate) => JSON.stringify(candidate.request) !== JSON.stringify(page0.request)
            ),
            (triggerSignal) => paginationButtons.nth(1).click({
              timeout: 10_000,
              signal: triggerSignal
            })
          );
          return {
            firstPage: page0.request,
            pagination: {
              mode: "paginated" as const,
              template: deriveUsagePageNumberTemplate(page0.request, page1.request)
            }
          };
        })();
    signal.throwIfAborted();
    const bundle = buildV2SessionBundle(workspaceId, authCookie.value, goRequest, usageList);
    const replay = await new OpenCodeUsageListSource(bundle).fetch(Date.now());
    if (replay.status === "unavailable") {
      throw new Error("usage.list 回放验证未通过");
    }
    return bundle;
  } finally {
    await cleanUpBrowserProfile(context, profileDirectory);
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
    const { uploadMode } = parseAuthSetupArgs(process.argv.slice(2));
    const bundle = await collectSessionBundle(controller.signal);
    controller.signal.throwIfAborted();
    const snapshot = await new OpenCodeConsoleQuotaSource(bundle).fetch(new Date());
    controller.signal.throwIfAborted();
    console.log([
      snapshot.windows.rolling.usedPercent,
      snapshot.windows.weekly.usedPercent,
      snapshot.windows.monthly.usedPercent
    ].map((percent) => `${percent}%`).join("\n"));
    await uploadSessionBundle(JSON.stringify(bundle), controller.signal, { uploadMode });
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
