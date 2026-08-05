import type { AppConfig } from "./config";
import { SourceError } from "./domain";
import { replayOpenCodeRequest } from "./opencode-http";
import {
  parseSessionBundle,
  renderUsagePageRequest,
  validateUsageListRequestDescriptor,
  type OpenCodeSessionBundle,
  type UsagePageNumberTemplate,
  type UsagePaginationAuthorization
} from "./opencode-session";
import { parseUsageListPage } from "./opencode-usage";
import type {
  UsageCollectionResult,
  UsageDetailsSource,
  UsageRecord
} from "./usage-domain";

const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const COLLECTION_DEADLINE_MS = 25_000;
const HOUR_MS = 60 * 60 * 1000;

function requirePaginationTemplate(
  pagination: UsagePaginationAuthorization
): UsagePageNumberTemplate {
  if (pagination.mode !== "paginated") {
    throw new SourceError("schema", "usage.list 缺少分页模板");
  }
  return pagination.template;
}

class UnavailableUsageDetailsSource implements UsageDetailsSource {
  async fetch(): Promise<UsageCollectionResult> {
    return { status: "unavailable", reason: "not-authorized" };
  }
}

export class OpenCodeUsageListSource implements UsageDetailsSource {
  constructor(
    private readonly rawBundle: string | OpenCodeSessionBundle,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now
  ) {}

  async fetch(observedAt: number): Promise<UsageCollectionResult> {
    if (!Number.isFinite(observedAt)) {
      throw new SourceError("schema", "usage.list 观察时间无效");
    }
    const bundle = parseSessionBundle(
      typeof this.rawBundle === "string"
        ? this.rawBundle
        : JSON.stringify(this.rawBundle)
    );
    if (bundle.version === 1) {
      return { status: "unavailable", reason: "not-authorized" };
    }

    const shanghaiHourStart =
      Math.floor((observedAt + 8 * HOUR_MS) / HOUR_MS) * HOUR_MS - 8 * HOUR_MS;
    const windowStartAt = shanghaiHourStart - 23 * HOUR_MS;
    const deadline = this.clock() + COLLECTION_DEADLINE_MS;
    const records: UsageRecord[] = [];
    const seen = new Map<string, string>();
    let previousUnique: UsageRecord | undefined;
    let pagesRead = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (this.clock() >= deadline) {
        return { status: "truncated", records, pagesRead, reason: "deadline" };
      }
      const request = page === 0
        ? bundle.usageList.firstPage
        : renderUsagePageRequest(
            bundle.usageList.firstPage,
            requirePaginationTemplate(bundle.usageList.pagination),
            page
          );
      validateUsageListRequestDescriptor(request, bundle.workspaceId, page);
      const deadlineController = new AbortController();
      const deadlineTimer = setTimeout(
        () => deadlineController.abort(),
        Math.max(0, deadline - this.clock())
      );
      let replay;
      try {
        replay = await replayOpenCodeRequest(
          request,
          bundle.auth.cookie,
          this.fetchImpl,
          deadlineController.signal
        );
      } catch (error) {
        if (deadlineController.signal.aborted && this.clock() >= deadline) {
          return { status: "truncated", records, pagesRead, reason: "deadline" };
        }
        throw error;
      } finally {
        clearTimeout(deadlineTimer);
      }

      const pageRecords = parseUsageListPage(replay.text, replay.contentType);
      pagesRead += 1;
      if (this.clock() >= deadline) {
        return { status: "truncated", records, pagesRead, reason: "deadline" };
      }
      if (
        page === 0 &&
        bundle.usageList.pagination.mode === "single-page" &&
        pageRecords.length === PAGE_SIZE
      ) {
        return { status: "unavailable", reason: "single-page-full" };
      }

      let reachedBoundary = false;
      for (const record of pageRecords) {
        const fingerprint = JSON.stringify(record);
        const priorFingerprint = seen.get(record.id);
        if (priorFingerprint !== undefined) {
          if (priorFingerprint !== fingerprint) {
            throw new SourceError("schema", "usage.list 同编号记录发生变化");
          }
          continue;
        }
        if (previousUnique && record.occurredAt > previousUnique.occurredAt) {
          throw new SourceError("schema", "usage.list 跨页记录不是倒序");
        }
        seen.set(record.id, fingerprint);
        previousUnique = record;
        if (record.occurredAt > observedAt) continue;
        if (record.occurredAt < windowStartAt) {
          reachedBoundary = true;
          break;
        }
        records.push(record);
      }
      if (reachedBoundary || pageRecords.length < PAGE_SIZE) {
        return { status: "complete", records, pagesRead };
      }
    }

    return {
      status: "truncated",
      records,
      pagesRead,
      reason: pagesRead === MAX_PAGES ? "page-limit" : "deadline"
    };
  }
}

export function createUsageDetailsSource(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
  clock: () => number = Date.now
): UsageDetailsSource {
  if (
    config.sourceName !== "opencode-console" ||
    !config.consoleEnabled ||
    config.sessionBundle === undefined
  ) {
    return new UnavailableUsageDetailsSource();
  }
  return new OpenCodeUsageListSource(config.sessionBundle, fetchImpl, clock);
}
