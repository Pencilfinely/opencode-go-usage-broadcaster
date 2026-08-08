import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { CollectorDisabledError } from "../src/domain";
import { createQuotaSource } from "../src/source";
import { createUsageDetailsSource } from "../src/opencode-usage-source";

const fixture = JSON.stringify({
  rollingUsage: { status: "ok", resetInSec: 3600, usagePercent: 49 },
  weeklyUsage: { status: "ok", resetInSec: 7200, usagePercent: 20 },
  monthlyUsage: { status: "ok", resetInSec: 10800, usagePercent: 10 }
});

const USAGE_FUNCTION_ID = "0123456789abcdef".repeat(4);

function usageUrl(page: number): string {
  const url = new URL("https://opencode.ai/_server");
  url.searchParams.set("id", USAGE_FUNCTION_ID);
  url.searchParams.set("args", JSON.stringify({
    t: { t: 9, i: 0, l: 2, a: [{ t: 1, s: "wrk_abc" }, { t: 0, s: page }], o: 0 },
    f: 31,
    m: []
  }));
  return url.toString();
}

function usageUrlTemplate(): { location: "url"; prefix: string; suffix: string } {
  const zero = usageUrl(0);
  const one = usageUrl(1);
  let start = 0;
  while (zero[start] === one[start]) start += 1;
  let zeroEnd = zero.length;
  let oneEnd = one.length;
  while (zero[zeroEnd - 1] === one[oneEnd - 1]) {
    zeroEnd -= 1;
    oneEnd -= 1;
  }
  return { location: "url", prefix: zero.slice(0, start), suffix: zero.slice(zeroEnd) };
}

type ConfigBindingOverrides = Partial<
  Omit<
    Cloudflare.Env,
    | "USAGE_SOURCE"
    | "USAGE_FIXTURE_JSON"
    | "OPENCODE_CONSOLE_ENABLED"
    | "OPENCODE_AUTH_GENERATION"
    | "OPENCODE_SESSION_BUNDLE"
    | "MANUAL_TRIGGER_SECRET"
    | "PUBLIC_BASE_URL"
    | "USAGE_CHART_SIGNING_SECRET"
  >
> & {
  USAGE_SOURCE?: string;
  USAGE_FIXTURE_JSON?: string;
  OPENCODE_CONSOLE_ENABLED?: string;
  OPENCODE_AUTH_GENERATION?: string | undefined;
  OPENCODE_SESSION_BUNDLE?: string | undefined;
  MANUAL_TRIGGER_SECRET?: string | undefined;
  PUBLIC_BASE_URL?: string | undefined;
  USAGE_CHART_SIGNING_SECRET?: string | undefined;
};

function makeEnv(overrides: ConfigBindingOverrides = {}): Cloudflare.Env {
  return {
    USAGE_SOURCE: "fixture",
    USAGE_FIXTURE_JSON: fixture,
    OPENCODE_CONSOLE_ENABLED: "false",
    OPENCODE_AUTH_GENERATION: "1",
    PUSHPLUS_TOKEN: "test-token",
    PUSHPLUS_TOPIC: "test-topic",
    PUSHPLUS_SECRET_KEY: "test-pushplus-secret-key-32-bytes-minimum",
    PUSHPLUS_CALLBACK_SECRET: "test-callback-secret-32-bytes-minimum",
    PUSHPLUS_CALLBACK_BASE_URL: "https://worker.test",
    MANUAL_TRIGGER_SECRET: "test-manual-trigger-secret-32-bytes-minimum",
    PUBLIC_BASE_URL: "https://usage-chart.example.test",
    USAGE_CHART_SIGNING_SECRET: "test-usage-chart-signing-secret-32-bytes-minimum",
    ...overrides
  } as Cloudflare.Env;
}

function makeV2SessionBundle(): string {
  return JSON.stringify({
    version: 2,
    generation: "generation-v2",
    createdAt: "2026-08-05T03:00:00.000Z",
    workspaceId: "wrk_abc",
    auth: { cookie: "auth=test-cookie" },
    goRequest: {
      url: "https://opencode.ai/workspace/wrk_abc/go",
      method: "GET",
      headers: { accept: "text/html" }
    },
    usageList: {
      firstPage: {
        url: usageUrl(0),
        method: "GET",
        headers: { accept: "text/javascript" }
      },
      pagination: {
        mode: "paginated",
        template: usageUrlTemplate()
      }
    }
  });
}

describe("quota source boundary", () => {
  it("允许未配置图片密钥，但拒绝过短图片密钥", () => {
    const validEnv = makeEnv();
    expect(loadConfig({
      ...validEnv,
      PUSHPLUS_SECRET_KEY: undefined
    } as unknown as Cloudflare.Env).pushplus.secretKey).toBeUndefined();
    expect(() => loadConfig({
      ...validEnv,
      PUSHPLUS_SECRET_KEY: "short"
    } as unknown as Cloudflare.Env)).toThrow("at least 32 characters");
  });

  it("版本 2 使用会话代次并可创建两类来源", async () => {
    const config = loadConfig(makeEnv({
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "true",
      OPENCODE_SESSION_BUNDLE: makeV2SessionBundle()
    }));
    const usageSource = createUsageDetailsSource(config, async () => new Response("[]", {
      headers: { "content-type": "application/json" }
    }));

    expect(config.authGeneration).toBe("generation-v2");
    expect(createQuotaSource(config)).toBeDefined();
    await expect(usageSource.fetch(Date.parse("2026-08-05T03:30:00.000Z"))).resolves.toEqual({
      status: "complete",
      records: [],
      pagesRead: 1
    });
  });

  it("版本 1 保持 Go 来源可用但明细来源降级", async () => {
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

    expect(createQuotaSource(config)).toBeDefined();
    await expect(createUsageDetailsSource(config).fetch(Date.now())).resolves.toEqual({
      status: "unavailable",
      reason: "not-authorized"
    });
  });

  it("fixture 与禁用控制台均创建不可用的明细来源", async () => {
    const fixtureSource = createUsageDetailsSource(loadConfig(makeEnv()));
    const disabledSource = createUsageDetailsSource(loadConfig(makeEnv({
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "false"
    })));

    await expect(fixtureSource.fetch(Date.now())).resolves.toEqual({
      status: "unavailable",
      reason: "not-authorized"
    });
    await expect(disabledSource.fetch(Date.now())).resolves.toEqual({
      status: "unavailable",
      reason: "not-authorized"
    });
  });

  it("损坏的分页模板在网络请求前归类为结构错误", async () => {
    const invalid = JSON.parse(makeV2SessionBundle()) as {
      usageList: { pagination: { template: { suffix: string } } };
    };
    invalid.usageList.pagination.template.suffix += "损坏";
    const invalidBundle = JSON.stringify(invalid);
    const config = loadConfig(makeEnv({
      USAGE_SOURCE: "opencode-console",
      OPENCODE_CONSOLE_ENABLED: "true",
      OPENCODE_SESSION_BUNDLE: invalidBundle
    }));
    let fetchCalls = 0;
    const source = createUsageDetailsSource(config, async () => {
      fetchCalls += 1;
      return new Response("[]", { headers: { "content-type": "application/json" } });
    });

    await expect(source.fetch(Date.parse("2026-08-05T03:30:00.000Z"))).rejects.toMatchObject({
      kind: "schema"
    });
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ["缺失", undefined],
    ["少于 32 个字符", "too-short"]
  ])("手动触发 Secret %s时拒绝加载配置", (_caseName, secret) => {
    expect(() => loadConfig(makeEnv({
      MANUAL_TRIGGER_SECRET: secret
    }))).toThrow();
  });

  it.each([
    ["HTTP", "http://usage-chart.example.test"],
    ["凭据", "https://user:pass@usage-chart.example.test"],
    ["路径", "https://usage-chart.example.test/path"],
    ["查询", "https://usage-chart.example.test?query=1"],
    ["片段", "https://usage-chart.example.test#fragment"],
    ["非标准端口", "https://usage-chart.example.test:8443"]
  ])("图表公开地址含%s时拒绝加载配置", (_caseName, publicBaseUrl) => {
    expect(() => loadConfig(makeEnv({ PUBLIC_BASE_URL: publicBaseUrl }))).toThrow();
  });

  it.each([undefined, "too-short"])('图表签名 Secret 为 %s 时拒绝加载配置', (secret) => {
    expect(() => loadConfig(makeEnv({ USAGE_CHART_SIGNING_SECRET: secret }))).toThrow();
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
