import type { AppConfig } from "./config";
import {
  CollectorDisabledError,
  SourceError,
  WINDOW_KEYS,
  type QuotaSnapshot,
  type QuotaSource,
  type UsageWindow,
  type WindowKey
} from "./domain";

type FixtureWindow = {
  status: "ok" | "rate-limited";
  resetInSec: number;
  usagePercent: number;
};

type FixturePayload = {
  error?: "auth" | "transient" | "schema";
  rollingUsage?: FixtureWindow;
  weeklyUsage?: FixtureWindow;
  monthlyUsage?: FixtureWindow;
};

function parseWindow(
  value: FixtureWindow | undefined,
  key: WindowKey,
  now: Date
): UsageWindow {
  if (!value) throw new SourceError("schema", "Missing window: " + key);
  if (value.status !== "ok" && value.status !== "rate-limited") {
    throw new SourceError("schema", "Invalid status: " + key);
  }
  if (
    !Number.isFinite(value.usagePercent) ||
    value.usagePercent < 0 ||
    value.usagePercent > 100
  ) {
    throw new SourceError("schema", "Invalid percentage: " + key);
  }
  if (!Number.isFinite(value.resetInSec) || value.resetInSec < 0) {
    throw new SourceError("schema", "Invalid reset: " + key);
  }
  const resetAt = now.getTime() + value.resetInSec * 1000;
  if (!Number.isFinite(resetAt) || Number.isNaN(new Date(resetAt).getTime())) {
    throw new SourceError("schema", "Reset is outside the valid range: " + key);
  }
  return {
    status: value.status,
    usedPercent: value.usagePercent,
    resetAt: new Date(resetAt).toISOString()
  };
}

export class FixtureQuotaSource implements QuotaSource {
  constructor(private readonly raw: string) {}

  async fetch(now: Date): Promise<QuotaSnapshot> {
    let value: FixturePayload;
    try {
      value = JSON.parse(this.raw) as FixturePayload;
    } catch {
      throw new SourceError("schema", "Fixture is not valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SourceError("schema", "Fixture must be an object");
    }
    if (value.error) {
      if (!["auth", "transient", "schema"].includes(value.error)) {
        throw new SourceError("schema", "Fixture has an invalid error kind");
      }
      throw new SourceError(value.error, "Fixture error: " + value.error);
    }
    const input = {
      rolling: value.rollingUsage,
      weekly: value.weeklyUsage,
      monthly: value.monthlyUsage
    };
    const windows = Object.fromEntries(
      WINDOW_KEYS.map((key) => [key, parseWindow(input[key], key, now)])
    ) as Record<WindowKey, UsageWindow>;

    return { source: "fixture", observedAt: now.toISOString(), windows };
  }
}

export class DisabledConsoleQuotaSource implements QuotaSource {
  async fetch(): Promise<QuotaSnapshot> {
    throw new CollectorDisabledError();
  }
}

export function createQuotaSource(config: AppConfig): QuotaSource {
  if (config.sourceName === "fixture") {
    return new FixtureQuotaSource(config.fixtureJson);
  }
  return new DisabledConsoleQuotaSource();
}
