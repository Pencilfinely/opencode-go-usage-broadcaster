import { describe, expect, it } from "vitest";
import { parseUsageListPage } from "../src/opencode-usage";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "use_1",
  timeCreated: "2026-08-05T02:30:00.000Z",
  provider: "anthropic",
  model: "claude-sonnet",
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  cost: 25000000,
  ...overrides
});

describe("OpenCode 用量列表单页", () => {
  it("把空推理和缓存字段规范化为零", () => {
    expect(parseUsageListPage(
      JSON.stringify([row()]),
      "application/json; charset=utf-8"
    )).toEqual([expect.objectContaining({
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      costMicroCents: 25000000
    })]);
  });

  it("拒绝非倒序的单页", () => {
    expect(() => parseUsageListPage(JSON.stringify([
      row({ id: "use_old", timeCreated: "2026-08-05T01:00:00.000Z" }),
      row({ id: "use_new", timeCreated: "2026-08-05T02:00:00.000Z" })
    ]), "text/javascript")).toThrow("倒序");
  });
});
