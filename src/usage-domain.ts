export interface UsageRecord {
  id: string;
  occurredAt: number;
  provider: string;
  model: string;
  plan?: "sub" | "byok" | "lite";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  costMicroCents: number;
}

export type UsageCollectionResult =
  | { status: "complete"; records: UsageRecord[]; pagesRead: number }
  | {
      status: "truncated";
      records: UsageRecord[];
      pagesRead: number;
      reason: "page-limit" | "deadline";
    }
  | {
      status: "unavailable";
      reason: "not-authorized" | "single-page-full";
    };

export interface UsageDetailsSource {
  fetch(observedAt: number): Promise<UsageCollectionResult>;
}

export interface UsageTokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  totalTokens: number;
}

export interface UsageHourBucket {
  startAt: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
}

export interface UsageModelTotal {
  model: string;
  tokenCount: number;
  sharePercent: number;
}

export interface UsageAggregate {
  observedAt: number;
  windowStartAt: number;
  truncated: boolean;
  requestCount: number;
  costMicroCents: number;
  tokens: UsageTokenTotals;
  buckets: UsageHourBucket[];
  models: UsageModelTotal[];
}

export type UsageUnavailableReason =
  | "not-authorized"
  | "single-page-full"
  | "auth"
  | "transient"
  | "schema";

export type UsageDetailsView =
  | { status: "available"; aggregate: UsageAggregate; chartUrl?: string }
  | { status: "unavailable"; reason: UsageUnavailableReason };
