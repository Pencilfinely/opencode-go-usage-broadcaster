export const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];
export type WindowStatus = "ok" | "rate-limited";

export interface UsageWindow {
  status: WindowStatus;
  usedPercent: number;
  resetAt: string;
  upstreamCycleId?: string;
}

export interface QuotaSnapshot {
  source: "fixture" | "opencode-console";
  observedAt: string;
  windows: Record<WindowKey, UsageWindow>;
}

export interface QuotaSource {
  fetch(now: Date): Promise<QuotaSnapshot>;
}

export type SourceErrorKind =
  | "auth"
  | "transient"
  | "schema"
  | "collector-disabled";

export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export class CollectorDisabledError extends SourceError {
  constructor() {
    super(
      "collector-disabled",
      "The real OpenCode console collector is not shipped in the safe MVP."
    );
    this.name = "CollectorDisabledError";
  }
}
