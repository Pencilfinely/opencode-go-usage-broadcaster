import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { uploadSessionBundle, type UploadChild } from "./auth-setup";

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
    await uploadSessionBundle(secret, {
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
