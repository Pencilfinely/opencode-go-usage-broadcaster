import { describe, expect, it } from "vitest";
import {
  parseSessionBundle,
  renderUsagePageRequest,
  type OpenCodeSessionBundleV2
} from "../src/opencode-session";

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
        url: "https://opencode.ai/_server?id=usage.list",
        method: "POST",
        headers: {
          accept: "text/javascript",
          "content-type": "application/json"
        },
        body: '["wrk_abc",0]'
      },
      pagination: {
        mode: "paginated",
        template: {
          location: "body",
          prefix: '["wrk_abc",',
          suffix: "]"
        }
      }
    }
  };
}

describe("OpenCode 会话包", () => {
  it("解析版本 2 并只替换请求体中的页号", () => {
    const bundle = parseSessionBundle(JSON.stringify(makeV2Bundle()));

    expect(bundle.version).toBe(2);
    if (bundle.version !== 2 || bundle.usageList.pagination.mode !== "paginated") {
      throw new Error("测试会话包不是分页版本 2");
    }
    expect(renderUsagePageRequest(
      bundle.usageList.firstPage,
      bundle.usageList.pagination.template,
      7
    ).body).toBe('["wrk_abc",7]');
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

  it("拒绝只替换无关查询值的分页模板", () => {
    const invalid = makeV2Bundle();
    invalid.usageList.firstPage.url = "https://opencode.ai/_server?id=usage.list0&source=console";
    invalid.usageList.pagination = {
      mode: "paginated",
      template: {
        location: "url",
        prefix: "https://opencode.ai/_server?id=usage.list",
        suffix: "&source=console"
      }
    };

    expect(() => parseSessionBundle(JSON.stringify(invalid))).toThrow();
  });
});
