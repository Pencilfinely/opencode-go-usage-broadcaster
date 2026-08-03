import { loadConfig } from "./config";
import {
  SourceError,
  WINDOW_KEYS,
  type QuotaSnapshot,
  type QuotaSource,
  type SourceErrorKind
} from "./domain";
import { dispatchDue } from "./pushplus";
import {
  Repository,
  type EventKind,
  type NewOutboxEvent
} from "./repository";
import {
  evaluateSnapshot,
  renderFaultMessage,
  renderStartupMessage,
  renderSummaryMessage,
  renderThresholdMessage,
  type QuotaState,
  type RenderedMessage,
  type ThresholdItem
} from "./rules";
import { createQuotaSource } from "./source";

export interface FaultEpisode {
  id: string;
  kind: SourceErrorKind;
  authGeneration: string;
  warningEventId: string;
  warningCreated: boolean;
  startedAt: number;
}

export interface RuntimeState {
  version: number;
  startupCreated: boolean;
  lastDailyCreatedDate?: string;
  faults: Partial<
    Record<"auth" | "transient" | "schema", FaultEpisode>
  >;
  transientRegularSlots: number[];
}

export interface AppDeps {
  source?: QuotaSource;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const EMPTY_RUNTIME: RuntimeState = {
  version: 0,
  startupCreated: false,
  faults: {},
  transientRegularSlots: []
};

const DAY_MS = 24 * 60 * 60 * 1000;
const REGULAR_SLOT_MS = 30 * 60 * 1000;
const SNAPSHOT_LEASE_MS = 120 * 1000;
const FAULT_KINDS = ["auth", "transient", "schema"] as const;

const FAULT_COPY: Record<
  (typeof FAULT_KINDS)[number],
  { title: string; action: string }
> = {
  auth: {
    title: "OpenCode Go 登录失效",
    action: "请更新 OpenCode 会话。"
  },
  transient: {
    title: "OpenCode Go 上游不可用",
    action: "请稍后检查 OpenCode 服务状态。"
  },
  schema: {
    title: "OpenCode Go 采集格式变化",
    action: "请更新用量采集适配器。"
  }
};

export function shanghaiDate(now: number): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );
  return values.year + "-" + values.month + "-" + values.day;
}

export function shanghaiMinute(now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );
  return Number(values.hour) * 60 + Number(values.minute);
}

export function nextShanghaiMidnight(now: number): number {
  return Date.parse(shanghaiDate(now) + "T16:00:00.000Z");
}

function jobKind(cron: string): "regular" | "daily" {
  return cron === "7 1 * * *" ? "daily" : "regular";
}

function classify(error: unknown): SourceErrorKind {
  return error instanceof SourceError ? error.kind : "transient";
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(
  source: QuotaSource,
  now: Date,
  sleep: (milliseconds: number) => Promise<void>
): Promise<QuotaSnapshot> {
  const delays = [250, 1000] as const;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await source.fetch(now);
    } catch (error) {
      if (classify(error) !== "transient" || attempt === delays.length) {
        throw error;
      }
      await sleep(delays[attempt]!);
    }
  }
  throw new SourceError("transient", "quota source retries exhausted");
}

async function deterministicEventId(logicalKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(logicalKey)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function newEvent(
  kind: EventKind,
  logicalKey: string,
  render: (eventId: string) => RenderedMessage,
  notAfter: number,
  triggers: ThresholdItem[]
): Promise<NewOutboxEvent> {
  const id = await deterministicEventId(logicalKey);
  const rendered = render(id);
  return {
    id,
    logicalKey,
    kind,
    title: rendered.title,
    content: rendered.content,
    notAfter,
    triggers
  };
}

function dailyDue(runtime: RuntimeState, now: number): boolean {
  return shanghaiMinute(now) >= 9 * 60 + 7 &&
    runtime.lastDailyCreatedDate !== shanghaiDate(now);
}

function faultKey(
  kind: (typeof FAULT_KINDS)[number],
  episodeId: string,
  transition: "warning" | "recovery"
): string {
  return "fault:" + kind + ":" + episodeId + ":" + transition;
}

function runtimeCopy(value: RuntimeState | null): RuntimeState {
  const runtime = value ?? EMPTY_RUNTIME;
  return {
    ...runtime,
    faults: { ...runtime.faults },
    transientRegularSlots: [...runtime.transientRegularSlots]
  };
}

function fixturePrefix(sourceName: "fixture" | "opencode-console"): string {
  return sourceName === "fixture" ? "【测试数据】" : "";
}

function validateSnapshot(snapshot: QuotaSnapshot): number {
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAt)) {
    throw new SourceError("schema", "snapshot observedAt is invalid");
  }
  for (const key of WINDOW_KEYS) {
    const window = snapshot.windows[key];
    if (
      !window ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      !Number.isFinite(Date.parse(window.resetAt))
    ) {
      throw new SourceError("schema", "snapshot window is invalid");
    }
  }
  return observedAt;
}

function earliestReset(items: Array<{ resetAt: string }>): number {
  return Math.min(...items.map((item) => Date.parse(item.resetAt)));
}

function thresholdLogicalKey(items: ThresholdItem[]): string {
  const parts = items.map(
    (item) => item.window + ":" + item.cycleKey + ":" + item.threshold
  );
  parts.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return "threshold:" + parts.join("|");
}

async function faultEvent(
  kind: (typeof FAULT_KINDS)[number],
  episodeId: string,
  transition: "warning" | "recovery",
  prefix: string,
  now: number
): Promise<NewOutboxEvent> {
  const logicalKey = faultKey(kind, episodeId, transition);
  const copy = transition === "warning"
    ? FAULT_COPY[kind]
    : {
        title: "OpenCode Go 采集已恢复",
        action: "OpenCode Go 用量采集已恢复。"
      };
  return newEvent(
    transition === "warning" ? "fault" : "recovery",
    logicalKey,
    (eventId) => renderFaultMessage(
      prefix + copy.title,
      prefix + copy.action,
      eventId
    ),
    now + DAY_MS,
    []
  );
}

function appendTransientSlot(runtime: RuntimeState, scheduledAt: number): void {
  if (runtime.transientRegularSlots.includes(scheduledAt)) return;
  const previous = runtime.transientRegularSlots.at(-1);
  runtime.transientRegularSlots = previous === scheduledAt - REGULAR_SLOT_MS
    ? [...runtime.transientRegularSlots, scheduledAt].slice(-3)
    : [scheduledAt];
}

export async function runScheduled(
  controller: ScheduledController,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  deps: AppDeps = {}
): Promise<void> {
  void ctx;
  const config = loadConfig(env);
  const repo = new Repository(env.DB);
  const now = deps.now?.() ?? Date.now();
  const scheduledAt = new Date(controller.scheduledTime).getTime();
  if (!Number.isFinite(scheduledAt)) {
    throw new Error("scheduledTime must be finite");
  }
  const source = deps.source ?? createQuotaSource(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  await dispatchDue(repo, config.pushplus, now, fetchImpl);
  try {
    const owner = crypto.randomUUID();
    const acquired = await repo.acquireSnapshotLease(
      owner,
      now,
      SNAPSHOT_LEASE_MS
    );
    if (!acquired) return;

    try {
      const kind = jobKind(controller.cron);
      const jobKey = kind + ":" + scheduledAt;
      if (!await repo.tryStartJob({
        key: jobKey,
        kind,
        scheduledAt,
        startedAt: now
      })) {
        return;
      }

      const previousQuota = await repo.loadState<QuotaState>("quota");
      const runtime = runtimeCopy(
        await repo.loadState<RuntimeState>("runtime")
      );

      if (scheduledAt <= runtime.version) {
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "skipped",
          errorKind: "stale-slot",
          states: [],
          events: []
        });
        return;
      }

      if (
        runtime.faults.auth?.authGeneration === config.authGeneration
      ) {
        runtime.version = scheduledAt;
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "skipped",
          errorKind: "auth-blocked",
          states: [{ key: "runtime", value: runtime, version: scheduledAt }],
          events: []
        });
        return;
      }

      let snapshot: QuotaSnapshot;
      let observedAt: number;
      try {
        snapshot = await fetchWithRetry(source, new Date(now), sleep);
        observedAt = validateSnapshot(snapshot);
      } catch (error) {
        const errorKind = classify(error);
        runtime.version = scheduledAt;
        const events: NewOutboxEvent[] = [];
        const prefix = fixturePrefix(config.sourceName);

        if (errorKind === "collector-disabled") {
          await repo.commitSnapshotUnderLease({
            owner,
            now,
            jobKey,
            jobStatus: "skipped",
            errorKind,
            states: [{ key: "runtime", value: runtime, version: scheduledAt }],
            events
          });
          return;
        }

        if (errorKind === "auth") {
          runtime.transientRegularSlots = [];
          const episodeId = "generation:" + config.authGeneration;
          const warning = await faultEvent(
            "auth",
            episodeId,
            "warning",
            prefix,
            now
          );
          runtime.faults.auth = {
            id: episodeId,
            kind: "auth",
            authGeneration: config.authGeneration,
            warningEventId: warning.id,
            warningCreated: true,
            startedAt: scheduledAt
          };
          events.push(warning);
        } else if (errorKind === "schema") {
          runtime.transientRegularSlots = [];
          if (!runtime.faults.schema) {
            const episodeId = "slot:" + scheduledAt;
            const warning = await faultEvent(
              "schema",
              episodeId,
              "warning",
              prefix,
              now
            );
            runtime.faults.schema = {
              id: episodeId,
              kind: "schema",
              authGeneration: config.authGeneration,
              warningEventId: warning.id,
              warningCreated: true,
              startedAt: scheduledAt
            };
            events.push(warning);
          }
        } else {
          if (kind === "regular") appendTransientSlot(runtime, scheduledAt);
          if (
            !runtime.faults.transient &&
            runtime.transientRegularSlots.length === 3
          ) {
            const episodeId = "slot:" + runtime.transientRegularSlots[0]!;
            const warning = await faultEvent(
              "transient",
              episodeId,
              "warning",
              prefix,
              now
            );
            runtime.faults.transient = {
              id: episodeId,
              kind: "transient",
              authGeneration: config.authGeneration,
              warningEventId: warning.id,
              warningCreated: true,
              startedAt: runtime.transientRegularSlots[0]!
            };
            events.push(warning);
          }
        }

        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "failed",
          errorKind,
          states: [{ key: "runtime", value: runtime, version: scheduledAt }],
          events
        });
        return;
      }

      const evaluation = evaluateSnapshot(previousQuota, snapshot, observedAt);
      const events: NewOutboxEvent[] = [];
      const snapshotExpiry = Math.min(
        earliestReset(WINDOW_KEYS.map((key) => snapshot.windows[key])),
        now + DAY_MS
      );

      if (evaluation.notifications.length > 0) {
        const logicalKey = thresholdLogicalKey(evaluation.notifications);
        const thresholdExpiry = Math.min(
          earliestReset(evaluation.notifications),
          now + DAY_MS
        );
        events.push(await newEvent(
          "threshold",
          logicalKey,
          (eventId) => renderThresholdMessage(
            snapshot,
            evaluation.notifications,
            eventId
          ),
          thresholdExpiry,
          evaluation.consumptions
        ));
      }

      if (!runtime.startupCreated) {
        events.push(await newEvent(
          "startup",
          "startup:v1",
          (eventId) => renderStartupMessage(snapshot, eventId),
          snapshotExpiry,
          []
        ));
        runtime.startupCreated = true;
      }

      if (dailyDue(runtime, now)) {
        const date = shanghaiDate(now);
        events.push(await newEvent(
          "daily",
          "daily:" + date,
          (eventId) => renderSummaryMessage(
            snapshot,
            eventId,
            kind !== "daily"
          ),
          nextShanghaiMidnight(now),
          []
        ));
        runtime.lastDailyCreatedDate = date;
      }

      const prefix = fixturePrefix(config.sourceName);
      for (const faultKind of FAULT_KINDS) {
        const episode = runtime.faults[faultKind];
        if (!episode) continue;
        if (
          episode.warningCreated &&
          await repo.isEventSucceeded(episode.warningEventId)
        ) {
          events.push(await faultEvent(
            faultKind,
            episode.id,
            "recovery",
            prefix,
            now
          ));
        }
        delete runtime.faults[faultKind];
      }
      runtime.transientRegularSlots = [];
      runtime.version = scheduledAt;
      evaluation.state.observationVersion = scheduledAt;

      await repo.commitSnapshotUnderLease({
        owner,
        now,
        jobKey,
        jobStatus: "succeeded",
        states: [
          { key: "quota", value: evaluation.state, version: scheduledAt },
          { key: "runtime", value: runtime, version: scheduledAt }
        ],
        events
      });
    } finally {
      await repo.releaseSnapshotLease(owner);
    }
  } finally {
    await dispatchDue(repo, config.pushplus, now, fetchImpl);
  }
}
