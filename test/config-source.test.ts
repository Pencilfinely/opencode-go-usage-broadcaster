import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { CollectorDisabledError } from "../src/domain";
import { createQuotaSource } from "../src/source";

const fixture = JSON.stringify({
  rollingUsage: { status: "ok", resetInSec: 3600, usagePercent: 49 },
  weeklyUsage: { status: "ok", resetInSec: 7200, usagePercent: 20 },
  monthlyUsage: { status: "ok", resetInSec: 10800, usagePercent: 10 }
});

type ConfigBindingOverrides = Partial<
  Omit<
    Cloudflare.Env,
    | "USAGE_SOURCE"
    | "USAGE_FIXTURE_JSON"
    | "OPENCODE_CONSOLE_ENABLED"
    | "OPENCODE_AUTH_GENERATION"
    | "OPENCODE_SESSION_BUNDLE"
    | "MANUAL_TRIGGER_SECRET"
  >
> & {
  USAGE_SOURCE?: string;
  USAGE_FIXTURE_JSON?: string;
  OPENCODE_CONSOLE_ENABLED?: string;
  OPENCODE_AUTH_GENERATION?: string | undefined;
  OPENCODE_SESSION_BUNDLE?: string | undefined;
  MANUAL_TRIGGER_SECRET?: string | undefined;
};

function makeEnv(overrides: ConfigBindingOverrides = {}): Cloudflare.Env {
  return {
    USAGE_SOURCE: "fixture",
    USAGE_FIXTURE_JSON: fixture,
    OPENCODE_CONSOLE_ENABLED: "false",
    OPENCODE_AUTH_GENERATION: "1",
    PUSHPLUS_TOKEN: "test-token",
    PUSHPLUS_TOPIC: "test-topic",
    PUSHPLUS_CALLBACK_SECRET: "test-callback-secret-32-bytes-minimum",
    PUSHPLUS_CALLBACK_BASE_URL: "https://worker.test",
    MANUAL_TRIGGER_SECRET: "test-manual-trigger-secret-32-bytes-minimum",
    ...overrides
  } as Cloudflare.Env;
}

describe("quota source boundary", () => {
  it.each([
    ["缺失", undefined],
    ["少于 32 个字符", "too-short"]
  ])("手动触发 Secret %s时拒绝加载配置", (_caseName, secret) => {
    expect(() => loadConfig(makeEnv({
      MANUAL_TRIGGER_SECRET: secret
    }))).toThrow();
  });

  it("parses all three fixture windows", async () => {
    const source = createQuotaSource(loadConfig(makeEnv()));
    const snapshot = await source.fetch(new Date("2026-08-03T01:00:00Z"));

    expect(snapshot.source).toBe("fixture");
    expect(snapshot.windows.rolling.usedPercent).toBe(49);
    expect(snapshot.windows.monthly.resetAt).toBe("2026-08-03T04:00:00.000Z");
  });

  it("rejects an incomplete fixture", async () => {
    const incomplete = JSON.stringify({
      rollingUsage: { status: "ok", resetInSec: 3600, usagePercent: 49 },
      weeklyUsage: { status: "ok", resetInSec: 7200, usagePercent: 20 }
    });
    const source = createQuotaSource(
      loadConfig(makeEnv({ USAGE_FIXTURE_JSON: incomplete }))
    );

    await expect(source.fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
    });
  });

  it("在显式开关关闭时不执行控制台请求", async () => {
    const source = createQuotaSource(
      loadConfig(
        makeEnv({
          USAGE_SOURCE: "opencode-console",
          OPENCODE_CONSOLE_ENABLED: "false"
        })
      )
    );
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("禁用的控制台来源不得调用 fetch");
    }) as typeof fetch;

    try {
      await expect(source.fetch(new Date())).rejects.toBeInstanceOf(
        CollectorDisabledError
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
  });

  it("启用控制台来源时使用会话包代次", async () => {
    const sessionBundle = JSON.stringify({
      version: 1,
      generation: "bundle-generation",
      createdAt: "2026-08-04T00:00:00.000Z",
      workspaceId: "workspace-1",
      auth: { cookie: "auth=session-value" },
      request: {
        url: "https://opencode.ai/workspace/workspace-1/go",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    const config = loadConfig(makeEnv({
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "true",
      OPENCODE_SESSION_BUNDLE: sessionBundle
    }));
    const source = createQuotaSource(config, async () => new Response(`
      <script>
        rollingUsage={status:"ok",resetInSec:3600,usagePercent:49};
        weeklyUsage:$R[5]={status:"ok",resetInSec:7200,usagePercent:20};
        monthlyUsage={status:"ok",resetInSec:10800,usagePercent:10};
      </script>
    `, { headers: { "content-type": "text/html" } }));

    const snapshot = await source.fetch(new Date("2026-08-04T01:00:00Z"));

    expect(config.authGeneration).toBe("bundle-generation");
    expect(snapshot.source).toBe("opencode-console");
    expect(snapshot.windows.rolling.usedPercent).toBe(49);
  });

  it("将损坏或缺失的会话包延迟到来源抓取时归类为结构错误", async () => {
    const damaged = loadConfig(makeEnv({
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "true",
      OPENCODE_SESSION_BUNDLE: "{损坏的秘密",
      OPENCODE_AUTH_GENERATION: undefined
    }));
    const missing = loadConfig(makeEnv({
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "true",
      OPENCODE_SESSION_BUNDLE: undefined,
      OPENCODE_AUTH_GENERATION: undefined
    }));

    expect(damaged.authGeneration).toBe(missing.authGeneration);
    expect(damaged.authGeneration).not.toContain("损坏的秘密");
    await expect(createQuotaSource(damaged).fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
    });
    await expect(createQuotaSource(missing).fetch(new Date())).rejects.toMatchObject({
      kind: "schema"
    });
  });
});
