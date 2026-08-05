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
