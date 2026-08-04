import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Response } from "playwright-core";

import {
  cleanUpBrowserProfile,
  UsageCandidateCollector,
  uploadSessionBundle,
  waitForEnter,
  type UploadChild
} from "./auth-setup";

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

  assert.match(command, /^npx(?:\.cmd)?$/u);
  assert.deepEqual(args, ["wrangler", "secret", "put", "OPENCODE_SESSION_BUNDLE"]);
  assert.equal(Buffer.concat(received).toString("utf8"), secret);
  assert.equal(args.some((item) => item.includes(secret)), false);
  assert.equal(Object.values(environment ?? {}).some((item) => item?.includes(secret)), false);
  assert.equal(logs.some((item) => item.includes(secret)), false);
});

test("取消等待输入时关闭提示并继续清理浏览器资料目录", async () => {
  const controller = new AbortController();
  const input = new PassThrough();
  const output = new PassThrough();
  const actions: string[] = [];

  const waiting = waitForEnter("等待登录：", controller.signal, input, output);
  controller.abort(new Error("用户取消"));
  await assert.rejects(waiting, /用户取消/u);

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

test("候选请求绑定响应页面的 Go 工作区且不会覆盖先完成的候选", async () => {
  let resolveFirst: ((payload: unknown) => void) | undefined;
  const firstPayload = new Promise<unknown>((resolvePayload) => {
    resolveFirst = resolvePayload;
  });
  const collector = new UsageCandidateCollector();
  collector.observe(responseFor("https://opencode.ai/workspace/第一工作区/go", firstPayload));
  collector.observe(responseFor("https://opencode.ai/workspace/第二工作区/go", usagePayload()));

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(collector.candidate?.workspaceId, "第二工作区");

  resolveFirst?.(usagePayload());
  await collector.waitForPending();
  assert.equal(collector.candidate?.workspaceId, "第二工作区");
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

function usagePayload(): unknown {
  return {
    rollingUsage: { usagePercent: 1, resetInSec: 60 },
    weeklyUsage: { usagePercent: 2, resetInSec: 120 },
    monthlyUsage: { usagePercent: 3, resetInSec: 180 }
  };
}

function responseFor(pageUrl: string, payload: unknown): Response {
  return {
    url: () => "https://opencode.ai/_server",
    json: async () => payload,
    request: () => ({
      method: () => "GET",
      headers: () => ({ accept: "application/json", authorization: "不会保留" }),
      postData: () => null,
      frame: () => ({ page: () => ({ url: () => pageUrl }) })
    })
  } as unknown as Response;
}
