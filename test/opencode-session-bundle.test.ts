import { describe, expect, it } from "vitest";
import {
  parseSessionBundle,
  renderUsagePageRequest,
  type OpenCodeSessionBundleV2
} from "../src/opencode-session";

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

function makeV2Bundle(): OpenCodeSessionBundleV2 {
  return {
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
  };
}

describe("OpenCode 会话包", () => {
  it("解析版本 2 并只替换 URL Seroval 参数中的页号", () => {
    const bundle = parseSessionBundle(JSON.stringify(makeV2Bundle()));

    expect(bundle.version).toBe(2);
    if (bundle.version !== 2 || bundle.usageList.pagination.mode !== "paginated") {
      throw new Error("测试会话包不是分页版本 2");
    }
    const rendered = renderUsagePageRequest(
      bundle.usageList.firstPage,
      bundle.usageList.pagination.template,
      7
    );
    const args = JSON.parse(new URL(rendered.url).searchParams.get("args") ?? "null") as {
      t: { a: [unknown, { s: number }] };
    };
    expect(rendered.body).toBeUndefined();
    expect(args.t.a[1].s).toBe(7);
  });

  it("保持版本 1 会话包兼容", () => {
    expect(parseSessionBundle(JSON.stringify({
      version: 1,
      generation: "generation-v1",
      createdAt: "2026-08-05T03:00:00.000Z",
      workspaceId: "wrk_abc",
      auth: { cookie: "auth=test-cookie" },
      request: {
        url: "https://opencode.ai/workspace/wrk_abc/go",
        method: "GET",
        headers: { accept: "text/html" }
      }
    }))).toMatchObject({ version: 1, generation: "generation-v1" });
  });

  it("拒绝损坏的 URL 分页模板", () => {
    const invalid = makeV2Bundle();
    const template = usageUrlTemplate();
    invalid.usageList.pagination = {
      mode: "paginated",
      template: {
        location: "url",
        prefix: template.prefix,
        suffix: template.suffix + "损坏"
      }
    };

    expect(() => parseSessionBundle(JSON.stringify(invalid))).toThrow();
  });
});
