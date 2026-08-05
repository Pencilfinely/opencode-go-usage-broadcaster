import { SourceError } from "./domain";
import { parseSolidStartSerovalStream } from "./solidstart-seroval";
import type { UsageRecord } from "./usage-domain";

const MAX_USAGE_GRAPH_NODES = 10_000;
const MAX_USAGE_GRAPH_DEPTH = 64;

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceError("schema", "usage.list 字段无效：" + field);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SourceError("schema", "usage.list 字段无效：" + field);
  }
  return value;
}

function requireSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SourceError("schema", "usage.list 字段无效：" + field);
  }
  return Number(value);
}

function optionalSafeInteger(value: unknown, field: string): number {
  if (value === null || value === undefined) return 0;
  return requireSafeInteger(value, field);
}

function requireOptionalPlan(value: unknown): UsageRecord["plan"] {
  if (value === null || value === undefined) return undefined;
  const enrichment = requireRecord(value, "enrichment");
  if (enrichment.plan === undefined || enrichment.plan === null) return undefined;
  if (enrichment.plan !== "sub" && enrichment.plan !== "byok" && enrichment.plan !== "lite") {
    throw new SourceError("schema", "usage.list 套餐来源无效");
  }
  return enrichment.plan;
}

function parseUsageRecord(value: unknown): UsageRecord {
  const item = requireRecord(value, "记录");
  const occurredAt = Date.parse(requireString(item.timeCreated, "timeCreated"));
  if (!Number.isFinite(occurredAt)) {
    throw new SourceError("schema", "usage.list 时间无效");
  }
  const plan = requireOptionalPlan(item.enrichment);
  return {
    id: requireString(item.id, "id"),
    occurredAt,
    provider: requireString(item.provider, "provider"),
    model: requireString(item.model, "model"),
    ...(plan === undefined ? {} : { plan }),
    inputTokens: requireSafeInteger(item.inputTokens, "inputTokens"),
    outputTokens: requireSafeInteger(item.outputTokens, "outputTokens"),
    reasoningTokens: optionalSafeInteger(item.reasoningTokens, "reasoningTokens"),
    cacheReadTokens: optionalSafeInteger(item.cacheReadTokens, "cacheReadTokens"),
    cacheWrite5mTokens: optionalSafeInteger(item.cacheWrite5mTokens, "cacheWrite5mTokens"),
    cacheWrite1hTokens: optionalSafeInteger(item.cacheWrite1hTokens, "cacheWrite1hTokens"),
    costMicroCents: requireSafeInteger(item.cost, "cost")
  };
}

function looksLikeUsageRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return [
    "id", "timeCreated", "provider", "model", "inputTokens", "outputTokens", "cost"
  ].every((key) => Object.hasOwn(item, key));
}

function collectUsageArrays(value: unknown, output: unknown[][]): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let visits = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visits += 1;
    if (visits > MAX_USAGE_GRAPH_NODES || current.depth > MAX_USAGE_GRAPH_DEPTH) {
      throw new SourceError("schema", "usage.list 响应结构过于复杂");
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (visited.has(current.value)) {
      throw new SourceError("schema", "usage.list 响应包含重复容器引用");
    }
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > 0 && current.value.every(looksLikeUsageRecord)) {
        output.push(current.value);
        continue;
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const children = Object.values(current.value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function startsWithFrameHeader(input: string | Uint8Array): boolean {
  return typeof input === "string"
    ? input.startsWith(";0x")
    : input[0] === 0x3b && input[1] === 0x30 && input[2] === 0x78;
}

function decodeUtf8(input: string | Uint8Array): string {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new SourceError("schema", "usage.list 响应不是有效 UTF-8");
  }
}

export function parseUsageListPage(
  input: string | Uint8Array,
  contentType: string
): UsageRecord[] {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (!["application/json", "text/javascript", "text/plain"].includes(mediaType)) {
    throw new SourceError("schema", "usage.list 响应类型无效");
  }
  let parsed: unknown;
  try {
    parsed = mediaType === "text/javascript" && startsWithFrameHeader(input)
      ? parseSolidStartSerovalStream(input)
      : JSON.parse(decodeUtf8(input));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("schema", "usage.list 响应不是有效 JSON");
  }
  if (Array.isArray(parsed) && parsed.length === 0) return [];
  const candidates: unknown[][] = [];
  collectUsageArrays(parsed, candidates);
  if (candidates.length !== 1) {
    throw new SourceError("schema", "usage.list 响应记录数组不唯一");
  }
  const records = candidates[0]!.map(parseUsageRecord);
  if (records.length > 50) {
    throw new SourceError("schema", "usage.list 单页超过 50 条");
  }
  for (let index = 1; index < records.length; index += 1) {
    if (records[index]!.occurredAt > records[index - 1]!.occurredAt) {
      throw new SourceError("schema", "usage.list 记录不是倒序");
    }
  }
  return records;
}
