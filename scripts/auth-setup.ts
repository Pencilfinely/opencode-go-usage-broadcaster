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

export type UploadChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "once">;

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

function waitForEnter(message: string): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => {
    readline.question(message, () => {
      readline.close();
      resolvePrompt();
    });
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

function currentWorkspaceId(context: BrowserContext): string | undefined {
  for (const page of context.pages()) {
    const workspaceId = workspaceIdFromUrl(page.url());
    if (workspaceId) return workspaceId;
  }
  return undefined;
}

async function collectSessionBundle(): Promise<OpenCodeSessionBundleV1> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  let context: BrowserContext | undefined;
  let capturedRequest: OpenCodeSessionBundleV1["request"] | undefined;
  try {
    context = await launchVisibleContext(profileDirectory);
    context.on("response", (response) => {
      if (capturedRequest || !isTargetResponse(response)) return;
      void response.json().then((payload: unknown) => {
        try {
          normalizeOpenCodeUsage(payload, new Date());
          capturedRequest = describeRequest(response);
        } catch {
          // 非用量响应不会参与会话包构造。
        }
      }).catch(() => undefined);
    });

    const page = await context.newPage();
    await page.goto(AUTH_URL);
    console.log("请在打开的浏览器中完成 GitHub 登录，并进入工作区的 Go 页面。");

    while (true) {
      await waitForEnter("完成后按回车继续检查：");
      const workspaceId = currentWorkspaceId(context);
      if (!workspaceId) {
        console.log("尚未检测到 Go 页面，请返回 https://opencode.ai/workspace/{id}/go 后重试。");
        continue;
      }
      if (!capturedRequest) {
        console.log("尚未捕获用量请求，请在 Go 页面刷新后按回车重试。");
        continue;
      }
      const authCookie = (await context.cookies(OPENCODE_ORIGIN)).find((cookie) => cookie.name === "auth");
      if (!authCookie) {
        console.log("未检测到 OpenCode auth Cookie，请完成登录后重试。");
        continue;
      }
      return parseSessionBundle(JSON.stringify({
        version: 1,
        generation: randomUUID(),
        createdAt: new Date().toISOString(),
        workspaceId,
        auth: { cookie: `auth=${authCookie.value}` },
        request: capturedRequest
      } satisfies OpenCodeSessionBundleV1));
    }
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
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
    child.once("error", () => rejectUpload(new Error("Secret 上传命令执行失败")));
    child.once("close", (code) => {
      if (code === 0) resolveUpload();
      else rejectUpload(new Error("Secret 上传失败"));
    });
    child.stdin.once("error", () => rejectUpload(new Error("Secret 上传输入失败")));
    child.stdin.end(sessionBundle, "utf8");
  });
}

async function main(): Promise<void> {
  const bundle = await collectSessionBundle();
  const snapshot = await new OpenCodeConsoleQuotaSource(bundle).fetch(new Date());
  console.log([
    snapshot.windows.rolling.usedPercent,
    snapshot.windows.weekly.usedPercent,
    snapshot.windows.monthly.usedPercent
  ].map((percent) => `${percent}%`).join("\n"));
  await uploadSessionBundle(JSON.stringify(bundle));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("授权失败，请关闭浏览器后重新运行该命令。");
    process.exitCode = 1;
  });
}
