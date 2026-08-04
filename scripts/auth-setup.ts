import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Response } from "playwright-core";

import {
  normalizeOpenCodeUsage,
  parseSessionBundle,
  validateOpenCodeRequest,
  type OpenCodeSessionBundleV1
} from "../src/opencode-session";
import { OpenCodeConsoleQuotaSource } from "../src/source";

const AUTH_URL = "https://opencode.ai/auth";
const OPENCODE_ORIGIN = "https://opencode.ai";
const TARGET_PATH = "/_server";
const UPLOAD_SECRET_NAME = "OPENCODE_SESSION_BUNDLE";
const UPLOAD_TIMEOUT_MS = 30_000;

export type UploadChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "once" | "kill">;

export type UsageCandidate = {
  workspaceId: string;
  request: OpenCodeSessionBundleV1["request"];
};

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

function isTargetResponse(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return url.origin === OPENCODE_ORIGIN && url.pathname === TARGET_PATH;
  } catch {
    return false;
  }
}

function describeRequest(response: Response): OpenCodeSessionBundleV1["request"] | undefined {
  const request = response.request();
  const method = request.method().toUpperCase();
  if (method !== "GET" && method !== "POST") return undefined;

  const headers = Object.fromEntries(
    Object.entries(request.headers())
      .filter(([name]) => ["accept", "content-type"].includes(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), value])
  );
  const body = method === "POST" ? request.postData() ?? undefined : undefined;
  try {
    return validateOpenCodeRequest({
      url: response.url(),
      method,
      headers,
      ...(body === undefined ? {} : { body })
    });
  } catch {
    return undefined;
  }
}

function workspaceIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== OPENCODE_ORIGIN) return undefined;
    const match = /^\/workspace\/([^/]+)\/go\/?$/u.exec(parsed.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("授权已取消");
}

export function waitForEnter(
  message: string,
  signal: AbortSignal,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<void> {
  const readline = createInterface({ input, output });
  return new Promise((resolvePrompt, rejectPrompt) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      readline.close();
      if (error) rejectPrompt(error);
      else resolvePrompt();
    };
    const onAbort = () => finish(abortError(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    readline.question(message, () => finish());
  });
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

export class UsageCandidateCollector {
  candidate: UsageCandidate | undefined;
  private readonly pending = new Set<Promise<void>>();

  observe(response: Response): void {
    if (this.candidate || !isTargetResponse(response)) return;
    const parsing = this.parse(response).then((candidate) => {
      if (candidate && !this.candidate) this.candidate = candidate;
    }).catch(() => undefined);
    this.pending.add(parsing);
    void parsing.finally(() => this.pending.delete(parsing));
  }

  async waitForPending(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async parse(response: Response): Promise<UsageCandidate | undefined> {
    try {
      const workspaceId = workspaceIdFromUrl(response.request().frame().page().url());
      if (!workspaceId) return undefined;
      const payload: unknown = await response.json();
      normalizeOpenCodeUsage(payload, new Date());
      const request = describeRequest(response);
      return request ? { workspaceId, request } : undefined;
    } catch {
      return undefined;
    }
  }
}

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

async function collectSessionBundle(signal: AbortSignal): Promise<OpenCodeSessionBundleV1> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  let context: BrowserContext | undefined;
  try {
    signal.throwIfAborted();
    context = await launchVisibleContext(profileDirectory);
    signal.throwIfAborted();
    const candidates = new UsageCandidateCollector();
    context.on("response", (response) => candidates.observe(response));

    const page = await context.newPage();
    await page.goto(AUTH_URL);
    console.log("请在打开的浏览器中完成 GitHub 登录，并进入工作区的 Go 页面。");

    while (true) {
      await waitForEnter("完成后按回车继续检查：", signal);
      await candidates.waitForPending();
      signal.throwIfAborted();
      const candidate = candidates.candidate;
      if (!candidate) {
        console.log("尚未捕获用量请求，请在 Go 页面刷新后按回车重试。");
        continue;
      }
      const authCookie = (await context.cookies(OPENCODE_ORIGIN)).find((cookie) => cookie.name === "auth");
      if (!authCookie) {
        console.log("未检测到 OpenCode auth Cookie，请完成登录后重试。");
        continue;
      }
      signal.throwIfAborted();
      return parseSessionBundle(JSON.stringify({
        version: 1,
        generation: randomUUID(),
        createdAt: new Date().toISOString(),
        workspaceId: candidate.workspaceId,
        auth: { cookie: `auth=${authCookie.value}` },
        request: candidate.request
      } satisfies OpenCodeSessionBundleV1));
    }
  } finally {
    await cleanUpBrowserProfile(context, profileDirectory);
  }
}

export async function uploadSessionBundle(
  sessionBundle: string,
  dependencies: UploadDependencies = {
    spawn: (command, args, options) =>
      spawn(command, args, options) as unknown as UploadChild
  }
): Promise<void> {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  await new Promise<void>((resolveUpload, rejectUpload) => {
    let child: UploadChild;
    try {
      child = dependencies.spawn(command, ["wrangler", "secret", "put", UPLOAD_SECRET_NAME], {
        stdio: ["pipe", "ignore", "inherit"]
      });
    } catch {
      rejectUpload(new Error("无法启动 Secret 上传命令"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => settle(new Error("Secret 上传超时")), UPLOAD_TIMEOUT_MS);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          child.kill();
        } finally {
          rejectUpload(error);
        }
      } else {
        resolveUpload();
      }
    };
    child.once("error", () => settle(new Error("Secret 上传命令执行失败")));
    child.once("close", (code) => {
      if (code === 0) settle();
      else settle(new Error("Secret 上传失败"));
    });
    child.stdin.once("error", () => settle(new Error("Secret 上传输入失败")));
    try {
      child.stdin.end(sessionBundle, "utf8");
    } catch {
      settle(new Error("Secret 上传输入失败"));
    }
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("授权已取消"));
  process.on("SIGINT", onSigint);
  try {
    const bundle = await collectSessionBundle(controller.signal);
    controller.signal.throwIfAborted();
    const snapshot = await new OpenCodeConsoleQuotaSource(bundle).fetch(new Date());
    controller.signal.throwIfAborted();
    console.log([
      snapshot.windows.rolling.usedPercent,
      snapshot.windows.weekly.usedPercent,
      snapshot.windows.monthly.usedPercent
    ].map((percent) => `${percent}%`).join("\n"));
    await uploadSessionBundle(JSON.stringify(bundle));
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
