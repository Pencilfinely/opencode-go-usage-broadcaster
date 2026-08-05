import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  cleanUpBrowserProfile,
  uploadSessionBundle,
  type UploadChild
} from "./auth-setup";

test("触发失败时取消内部 waiter 并回收其拒绝后重抛原始错误", async () => {
  const module = await import("./opencode-usage-capture");
  const waitBeforeTrigger = (module as Record<string, unknown>)
    .waitBeforeTrigger as ((
      externalSignal: AbortSignal,
      startWaiter: (signal: AbortSignal) => Promise<unknown>,
      trigger: (signal: AbortSignal) => Promise<void>
    ) => Promise<unknown>) | undefined;
  if (!waitBeforeTrigger) throw new Error("缺少等待触发协作器");
  const triggerError = new Error("触发动作失败");
  let receivedSignal: AbortSignal | undefined;
  let waiterSettled = false;

  await assert.rejects(
    waitBeforeTrigger?.(
      new AbortController().signal,
      (signal) => new Promise((_, reject) => {
        receivedSignal = signal;
        signal.addEventListener("abort", () => {
          queueMicrotask(() => {
            waiterSettled = true;
            reject(new Error("waiter 已取消"));
          });
        }, { once: true });
      }),
      async () => { throw triggerError; }
    ),
    (error: unknown) => error === triggerError
  );

  assert.equal(receivedSignal?.aborted, true);
  assert.equal(waiterSettled, true);
});

test("只保留捕获请求的必要头", async () => {
  const module = await import("./opencode-usage-capture");
  const minimizeCapturedRequest = (module as Record<string, unknown>)
    .minimizeCapturedRequest as ((request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => unknown) | undefined;

  assert.deepEqual(minimizeCapturedRequest?.({
    url: "https://opencode.ai/_server?id=usage.list",
    method: "POST",
    headers: {
      accept: "text/javascript",
      "content-type": "application/json",
      cookie: "不得进入结果",
      origin: "https://opencode.ai",
      "x-test": "不得进入结果"
    },
    body: '["wrk_abc",0]'
  }), {
    url: "https://opencode.ai/_server?id=usage.list",
    method: "POST",
    headers: {
      accept: "text/javascript",
      "content-type": "application/json"
    },
    body: '["wrk_abc",0]'
  });
});

test("页号模板拒绝 URL 的固定部分变化", async () => {
  const module = await import("./opencode-usage-capture");
  const deriveUsagePageNumberTemplate = (module as Record<string, unknown>)
    .deriveUsagePageNumberTemplate as ((
      zero: { url: string; method: string; headers: Record<string, string>; body?: string },
      one: { url: string; method: string; headers: Record<string, string>; body?: string }
    ) => unknown) | undefined;

  assert.throws(() => deriveUsagePageNumberTemplate?.(
    {
      url: "https://opencode.ai/_server?id=usage.list&source=console",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["wrk_abc",0]'
    },
    {
      url: "https://opencode.ai/_server?id=usage.list&source=web",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["wrk_abc",1]'
    }
  ));
});

test("页号模板拒绝请求头变化", async () => {
  const module = await import("./opencode-usage-capture");
  const deriveUsagePageNumberTemplate = (module as Record<string, unknown>)
    .deriveUsagePageNumberTemplate as ((
      zero: { url: string; method: string; headers: Record<string, string>; body?: string },
      one: { url: string; method: string; headers: Record<string, string>; body?: string }
    ) => unknown) | undefined;

  assert.throws(() => deriveUsagePageNumberTemplate?.(
    {
      url: "https://opencode.ai/_server?id=usage.list",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '["wrk_abc",0]'
    },
    {
      url: "https://opencode.ai/_server?id=usage.list",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '["wrk_abc",1]'
    }
  ));
});

test("版本级模式使用 versions secret put", async () => {
  const module = await import("./auth-setup");
  const buildWranglerSecretArgs = (module as Record<string, unknown>)
    .buildWranglerSecretArgs as ((cli: string, mode: string) => string[]) | undefined;

  assert.deepEqual(buildWranglerSecretArgs?.("wrangler.js", "version-only"), [
    "wrangler.js", "versions", "secret", "put", "OPENCODE_SESSION_BUNDLE"
  ]);
});

test("仅接受可选的版本级上传参数", async () => {
  const module = await import("./auth-setup");
  const parseAuthSetupArgs = (module as Record<string, unknown>)
    .parseAuthSetupArgs as ((argv: readonly string[]) => unknown) | undefined;

  assert.deepEqual(parseAuthSetupArgs?.([]), { uploadMode: "deployed" });
  assert.deepEqual(parseAuthSetupArgs?.(["--version-only"]), { uploadMode: "version-only" });
  assert.throws(() => parseAuthSetupArgs?.(["--bad"]));
});

test("从目标工作区页及其子页识别受限的工作区 ID", async () => {
  const module = await import("./auth-setup");
  const workspaceIdFromPageUrl = (module as Record<string, unknown>)
    .workspaceIdFromPageUrl as ((url: string) => string | undefined) | undefined;

  assert.equal(
    workspaceIdFromPageUrl?.("https://opencode.ai/workspace/wrk_Alpha42"),
    "wrk_Alpha42"
  );
  assert.equal(
    workspaceIdFromPageUrl?.("https://opencode.ai/workspace/wrk_Alpha42/settings"),
    "wrk_Alpha42"
  );
  assert.equal(workspaceIdFromPageUrl?.("https://evil.example/workspace/wrk_Alpha42"), undefined);
  assert.equal(workspaceIdFromPageUrl?.("https://opencode.ai/workspace/not-safe"), undefined);
});

test("为工作区生成官方 usage 页面地址", async () => {
  const module = await import("./auth-setup");
  const workspaceUsageUrl = (module as Record<string, unknown>)
    .workspaceUsageUrl as ((workspaceId: string) => string) | undefined;

  assert.equal(
    workspaceUsageUrl?.("wrk_Target9"),
    "https://opencode.ai/workspace/wrk_Target9/usage"
  );
});

test("轮询当前及上下文页面直到识别目标工作区", async () => {
  const module = await import("./auth-setup");
  const waitForWorkspaceId = (module as Record<string, unknown>)
    .waitForWorkspaceId as (
      context: { pages(): Array<{ url(): string }> },
      signal: AbortSignal,
      pause: (signal: AbortSignal) => Promise<void>
    ) => Promise<string>;
  const urls = ["https://opencode.ai/auth"];
  let pauses = 0;

  const workspaceId = await waitForWorkspaceId(
    { pages: () => urls.map((url) => ({ url: () => url })) },
    new AbortController().signal,
    async () => {
      pauses += 1;
      urls.push("https://opencode.ai/workspace/wrk_Target9/preferences");
    }
  );

  assert.equal(workspaceId, "wrk_Target9");
  assert.equal(pauses, 1);
});

test("为已识别工作区构造经严格校验的 V2 会话包", async () => {
  const module = await import("./auth-setup");
  const buildSessionBundle = (module as Record<string, unknown>)
    .buildSessionBundle as (
      workspaceId: string,
      authCookie: string,
      goRequest: { url: string; method: string; headers: Record<string, string> },
      usageList: unknown
    ) => { version: number; workspaceId: string; auth: { cookie: string }; goRequest: unknown };

  const bundle = buildSessionBundle(
    "wrk_Target9",
    "cookie-value",
    {
      url: "https://opencode.ai/workspace/wrk_Target9/go",
      method: "GET",
      headers: { accept: "text/html" }
    },
    {
      firstPage: {
        url: "https://opencode.ai/_server?id=usage.list",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '["wrk_Target9",0]'
      },
      pagination: { mode: "single-page" }
    }
  );

  assert.equal(bundle.version, 2);
  assert.equal(bundle.workspaceId, "wrk_Target9");
  assert.equal(bundle.auth.cookie, "auth=cookie-value");
  assert.deepEqual(bundle.goRequest, {
    url: "https://opencode.ai/workspace/wrk_Target9/go",
    method: "GET",
    headers: { accept: "text/html" }
  });
});

test("上传会话包时仅通过子进程标准输入传递敏感内容", async () => {
  const secret = '{"auth":{"cookie":"auth=不应泄露"}}';
  const received: Buffer[] = [];
  const logs: string[] = [];
  let command = "";
  let args: readonly string[] = [];
  let environment: NodeJS.ProcessEnv | undefined;

  const emitter = new EventEmitter();
  const child = emitter as unknown as UploadChild & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.stdin.on("data", (chunk: Buffer) => received.push(chunk));

  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    await uploadSessionBundle(secret, new AbortController().signal, {
      spawn(commandName, commandArgs, options) {
        command = commandName;
        args = commandArgs;
        environment = options.env;
        queueMicrotask(() => emitter.emit("close", 0));
        return child;
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(command, process.execPath);
  assert.match(args[0] ?? "", /[\\/]node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/u);
  assert.deepEqual(args.slice(1), ["secret", "put", "OPENCODE_SESSION_BUNDLE"]);
  assert.equal(Buffer.concat(received).toString("utf8"), secret);
  assert.equal(args.some((item) => item.includes(secret)), false);
  assert.equal(Object.values(environment ?? {}).some((item) => item?.includes(secret)), false);
  assert.equal(logs.some((item) => item.includes(secret)), false);
});

test("浏览器关闭失败时仍清理资料目录", async () => {
  const actions: string[] = [];

  await assert.rejects(
    cleanUpBrowserProfile(
      { close: async () => {
        actions.push("关闭浏览器");
        throw new Error("关闭失败");
      } },
      "C:\\临时资料目录",
      async () => { actions.push("删除目录"); }
    ),
    /关闭失败/u
  );
  assert.deepEqual(actions, ["关闭浏览器", "删除目录"]);
});

test("上传输入失败时终止仍在运行的上传子进程", async () => {
  let killed = 0;
  const emitter = new EventEmitter();
  const child = emitter as unknown as UploadChild & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.kill = () => {
    killed += 1;
    return true;
  };

  const uploading = uploadSessionBundle("秘密会话", new AbortController().signal, {
    spawn() {
      queueMicrotask(() => child.stdin.emit("error", new Error("输入失败")));
      return child;
    }
  });

  await assert.rejects(uploading, /上传输入失败/u);
  assert.equal(killed, 1);
});

test("上传开始前已取消时不启动子进程", async () => {
  const controller = new AbortController();
  controller.abort(new Error("用户取消上传"));
  let spawnCalls = 0;

  await assert.rejects(
    uploadSessionBundle("秘密会话", controller.signal, {
      spawn() {
        spawnCalls += 1;
        throw new Error("不得启动");
      }
    }),
    /用户取消上传/u
  );
  assert.equal(spawnCalls, 0);
});

test("上传期间取消时终止子进程并等待关闭后拒绝", async () => {
  const controller = new AbortController();
  const emitter = new EventEmitter();
  const child = emitter as unknown as UploadChild & { stdin: PassThrough };
  child.stdin = new PassThrough();
  let killed = 0;
  child.kill = () => {
    killed += 1;
    return true;
  };

  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const uploading = uploadSessionBundle("秘密会话", controller.signal, {
    spawn() {
      return child;
    }
  });
  void uploading.then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; }
  );

  controller.abort(new Error("用户取消上传"));
  await Promise.resolve();
  const outcomeBeforeClose = outcome;
  const killedBeforeClose = killed;
  emitter.emit("close", 0);

  await assert.rejects(uploading, /用户取消上传/u);
  assert.equal(killedBeforeClose, 1);
  assert.equal(outcomeBeforeClose, "pending");
  assert.equal(outcome, "rejected");
});
