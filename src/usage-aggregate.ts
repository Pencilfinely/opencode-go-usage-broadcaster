import type {
  UsageAggregate,
  UsageHourBucket,
  UsageModelTotal,
  UsageRecord,
  UsageTokenTotals
} from "./usage-domain";

const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

function shanghaiHourStart(timestamp: number): number {
  return Math.floor((timestamp + SHANGHAI_OFFSET_MS) / HOUR_MS) * HOUR_MS -
    SHANGHAI_OFFSET_MS;
}

function requireSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("用量记录数值无效：" + field);
  }
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  requireSafeInteger(value, field);
  if (value < 0) throw new RangeError("用量记录数值无效：" + field);
}

function addSafely(left: number, right: number, field: string): number {
  const total = left + right;
  requireNonNegativeSafeInteger(total, field);
  return total;
}

function emptyBucket(startAt: number): UsageHourBucket {
  return {
    startAt,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0
  };
}

function validateRecord(record: UsageRecord): void {
  requireSafeInteger(record.occurredAt, "occurredAt");
  requireNonNegativeSafeInteger(record.inputTokens, "inputTokens");
  requireNonNegativeSafeInteger(record.outputTokens, "outputTokens");
  requireNonNegativeSafeInteger(record.reasoningTokens, "reasoningTokens");
  requireNonNegativeSafeInteger(record.cacheReadTokens, "cacheReadTokens");
  requireNonNegativeSafeInteger(record.cacheWrite5mTokens, "cacheWrite5mTokens");
  requireNonNegativeSafeInteger(record.cacheWrite1hTokens, "cacheWrite1hTokens");
  requireNonNegativeSafeInteger(record.costMicroCents, "costMicroCents");
}

function modelTotals(
  modelTokens: Map<string, number>,
  totalTokens: number
): UsageModelTotal[] {
  const ranked = [...modelTokens.entries()]
    .sort(([leftModel, leftTokens], [rightModel, rightTokens]) =>
      rightTokens - leftTokens || leftModel.localeCompare(rightModel)
    );
  const displayed = ranked.slice(0, 5);
  const otherTokens = ranked.slice(5).reduce(
    (sum, [, tokenCount]) => addSafely(sum, tokenCount, "models"),
    0
  );
  if (ranked.length > 5) displayed.push(["其他", otherTokens]);
  return displayed.map(([model, tokenCount]) => ({
    model,
    tokenCount,
    sharePercent: totalTokens === 0 ? 0 : tokenCount / totalTokens * 100
  }));
}

export function aggregateUsage24h(
  records: UsageRecord[],
  observedAt: number,
  truncated: boolean
): UsageAggregate {
  requireSafeInteger(observedAt, "observedAt");
  const currentHourStart = shanghaiHourStart(observedAt);
  const windowStartAt = currentHourStart - 23 * HOUR_MS;
  const buckets = Array.from(
    { length: 24 },
    (_, index) => emptyBucket(windowStartAt + index * HOUR_MS)
  );
  const tokens: UsageTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0
  };
  const modelTokens = new Map<string, number>();
  let requestCount = 0;
  let costMicroCents = 0;

  for (const record of records) {
    validateRecord(record);
    if (record.occurredAt < windowStartAt || record.occurredAt > observedAt) {
      continue;
    }
    const cacheTokens = addSafely(
      addSafely(record.cacheReadTokens, record.cacheWrite5mTokens, "cacheTokens"),
      record.cacheWrite1hTokens,
      "cacheTokens"
    );
    const tokenCount = addSafely(
      addSafely(
        addSafely(record.inputTokens, record.outputTokens, "totalTokens"),
        record.reasoningTokens,
        "totalTokens"
      ),
      cacheTokens,
      "totalTokens"
    );
    const bucketIndex = (shanghaiHourStart(record.occurredAt) - windowStartAt) / HOUR_MS;
    const bucket = buckets[bucketIndex];
    if (!bucket) throw new RangeError("用量记录小时桶无效");
    bucket.inputTokens = addSafely(bucket.inputTokens, record.inputTokens, "inputTokens");
    bucket.outputTokens = addSafely(bucket.outputTokens, record.outputTokens, "outputTokens");
    bucket.reasoningTokens = addSafely(bucket.reasoningTokens, record.reasoningTokens, "reasoningTokens");
    bucket.cacheTokens = addSafely(bucket.cacheTokens, cacheTokens, "cacheTokens");
    tokens.inputTokens = addSafely(tokens.inputTokens, record.inputTokens, "inputTokens");
    tokens.outputTokens = addSafely(tokens.outputTokens, record.outputTokens, "outputTokens");
    tokens.reasoningTokens = addSafely(tokens.reasoningTokens, record.reasoningTokens, "reasoningTokens");
    tokens.cacheTokens = addSafely(tokens.cacheTokens, cacheTokens, "cacheTokens");
    tokens.totalTokens = addSafely(tokens.totalTokens, tokenCount, "totalTokens");
    requestCount = addSafely(requestCount, 1, "requestCount");
    costMicroCents = addSafely(costMicroCents, record.costMicroCents, "costMicroCents");
    modelTokens.set(
      record.model,
      addSafely(modelTokens.get(record.model) ?? 0, tokenCount, "models")
    );
  }

  return {
    observedAt,
    windowStartAt,
    truncated,
    requestCount,
    costMicroCents,
    tokens,
    buckets,
    models: modelTotals(modelTokens, tokens.totalTokens)
  };
}
