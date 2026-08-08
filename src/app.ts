import { loadConfig } from "./config";
import {
  SourceError,
  WINDOW_KEYS,
  type QuotaSnapshot,
  type QuotaSource,
  type SourceErrorKind
} from "./domain";
import { dispatchDue } from "./pushplus";
import { PushPlusImageError, uploadPushPlusPng } from "./pushplus-image";
import {
  Repository,
  type EventKind,
  type NewOutboxEvent
} from "./repository";
import {
  evaluateSnapshot,
  renderFaultMessage,
  renderBroadcastMessage,
  type QuotaState,
  type RenderedMessage,
  type ThresholdItem
} from "./rules";
import { createQuotaSource } from "./source";
import { aggregateUsage24h } from "./usage-aggregate";
import { UsageChartPngError, renderUsageChartPng } from "./usage-chart-png";
import type {
  UsageAggregate,
  UsageDetailsSource,
  UsageDetailsView,
  UsageUnavailableReason
} from "./usage-domain";
import { createUsageDetailsSource } from "./opencode-usage-source";

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
  usageSource?: UsageDetailsSource;
  chartImagePublisher?: UsageChartImagePublisher;
  fetchImpl?: typeof fetch;
  sourceFetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export type UsageChartImagePublisher = (
  aggregate: UsageAggregate,
  eventId: string
) => Promise<string>;

export type BroadcastTrigger =
  | { type: "scheduled"; occurredAt: number }
  | { type: "manual"; occurredAt: number; idempotencyDigest: string };

export type BroadcastResult = "completed" | "duplicate" | "busy" | "failed";

const EMPTY_RUNTIME: RuntimeState = {
  version: 0,
  startupCreated: false,
  faults: {},
  transientRegularSlots: []
};

const DAY_MS = 24 * 60 * 60 * 1000;
const REGULAR_SLOT_MS = 60 * 60 * 1000;
const SNAPSHOT_LEASE_MS = 120 * 1000;
const SNAPSHOT_LEASE_RETRY_MS = 1000;
const SNAPSHOT_LEASE_MAX_RETRIES =
  SNAPSHOT_LEASE_MS / SNAPSHOT_LEASE_RETRY_MS;
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

function shanghaiHour(now: number): number {
  return Math.floor(shanghaiMinute(now) / 60);
}

export function isShanghaiBroadcastSlot(timestamp: number): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const minute = shanghaiMinute(timestamp);
  return minute % 60 === 0 && minute >= 9 * 60 && minute <= 23 * 60;
}

function nextShanghaiHour(now: number): number {
  return (Math.floor(now / REGULAR_SLOT_MS) + 1) * REGULAR_SLOT_MS;
}

function broadcastLogicalKey(trigger: BroadcastTrigger): string {
  if (trigger.type === "manual") {
    return "broadcast:manual:" + trigger.idempotencyDigest;
  }
  return "broadcast:scheduled:" + shanghaiDate(trigger.occurredAt) + ":" +
    String(shanghaiHour(trigger.occurredAt)).padStart(2, "0");
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
  render: (eventId: string) => RenderedMessage | Promise<RenderedMessage>,
  notAfter: number,
  triggers: ThresholdItem[]
): Promise<NewOutboxEvent> {
  const id = await deterministicEventId(logicalKey);
  const rendered = await render(id);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPushPlusPictureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "pic.pushplus.plus" &&
      !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function validateSnapshot(snapshot: unknown): number {
  if (
    !isRecord(snapshot) ||
    (snapshot.source !== "fixture" && snapshot.source !== "opencode-console") ||
    typeof snapshot.observedAt !== "string" ||
    !isRecord(snapshot.windows)
  ) {
    throw new SourceError("schema", "snapshot is invalid");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAt)) {
    throw new SourceError("schema", "snapshot observedAt is invalid");
  }
  for (const key of WINDOW_KEYS) {
    const window = snapshot.windows[key];
    if (
      !isRecord(window) ||
      (window.status !== "ok" && window.status !== "rate-limited") ||
      typeof window.usedPercent !== "number" ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      typeof window.resetAt !== "string" ||
      !Number.isFinite(Date.parse(window.resetAt))
    ) {
      throw new SourceError("schema", "snapshot window is invalid");
    }
  }
  return observedAt;
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
  const scheduledAt = new Date(controller.scheduledTime).getTime();
  if (!Number.isFinite(scheduledAt)) {
    throw new Error("scheduledTime must be finite");
  }
  if (!isShanghaiBroadcastSlot(scheduledAt)) return;
  await runBroadcast({ type: "scheduled", occurredAt: scheduledAt }, env, deps);
}

async function acquireBroadcastLease(
  repo: Repository,
  owner: string,
  trigger: BroadcastTrigger,
  clock: () => number,
  sleep: (milliseconds: number) => Promise<void>
): Promise<boolean> {
  const slotEnd = trigger.type === "scheduled"
    ? nextShanghaiHour(trigger.occurredAt)
    : undefined;
  for (let retries = 0; ; retries += 1) {
    const attemptNow = clock();
    if (slotEnd !== undefined && attemptNow >= slotEnd) return false;
    if (await repo.acquireSnapshotLease(
      owner,
      attemptNow,
      SNAPSHOT_LEASE_MS
    )) {
      return true;
    }
    if (
      trigger.type === "manual" ||
      retries >= SNAPSHOT_LEASE_MAX_RETRIES
    ) {
      return false;
    }
    await sleep(Math.min(SNAPSHOT_LEASE_RETRY_MS, slotEnd! - attemptNow));
  }
}

export async function runBroadcast(
  trigger: BroadcastTrigger,
  env: Cloudflare.Env,
  deps: AppDeps = {}
): Promise<BroadcastResult> {
  const config = loadConfig(env);
  const repo = new Repository(env.DB);
  const clock = deps.now ?? Date.now;
  const scheduledAt = trigger.occurredAt;
  const isScheduled = trigger.type === "scheduled";
  if (!Number.isFinite(scheduledAt)) {
    throw new Error("occurredAt must be finite");
  }
  const scheduledNotAfter = isScheduled
    ? nextShanghaiHour(scheduledAt)
    : undefined;
  const source = deps.source ?? createQuotaSource(
    config,
    deps.sourceFetchImpl ?? fetch
  );
  const usageSource = deps.usageSource ?? createUsageDetailsSource(
    config,
    deps.sourceFetchImpl,
    clock
  );
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const chartImagePublisher = deps.chartImagePublisher ?? (async (
    aggregate,
    eventId
  ) => {
    const secretKey = config.pushplus.secretKey;
    if (secretKey === undefined) {
      throw new PushPlusImageError("access_key", "invalid");
    }
    const rendered = await renderUsageChartPng(env.BROWSER, aggregate);
    console.log(JSON.stringify({
      event: "usage_chart_png_rendered",
      eventId,
      browserMs: rendered.browserMs
    }));
    return await uploadPushPlusPng({
      token: config.pushplus.token,
      secretKey
    }, rendered.bytes);
  });

  try {
  if (scheduledNotAfter !== undefined && clock() >= scheduledNotAfter) {
    return "completed";
  }
  await dispatchDue(repo, config.pushplus, clock, fetchImpl);
  let dispatchedAfterCommit = false;
  try {
    const owner = crypto.randomUUID();
    const acquired = await acquireBroadcastLease(
      repo,
      owner,
      trigger,
      clock,
      sleep
    );
    if (!acquired) return "busy";

    let startedJobKey: string | undefined;
    try {
      let now = clock();
      const kind = "regular" as const;
      const jobKey = broadcastLogicalKey(trigger);
      if (!await repo.tryStartJob({
        key: jobKey,
        kind,
        scheduledAt,
        startedAt: now
      })) {
        if (!isScheduled) {
          const eventId = await deterministicEventId(jobKey);
          return await repo.isEventSucceeded(eventId)
            ? "duplicate"
            : "failed";
        }
        return "duplicate";
      }
      startedJobKey = jobKey;

      const previousQuota = await repo.loadState<QuotaState>("quota");
      const runtime = runtimeCopy(
        await repo.loadState<RuntimeState>("runtime")
      );

      if (isScheduled && scheduledAt <= runtime.version) {
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "skipped",
          errorKind: "stale-slot",
          states: [],
          events: [],
          usageChartSnapshots: []
        });
        return "completed";
      }

      if (
        runtime.faults.auth?.authGeneration === config.authGeneration
      ) {
        const events: NewOutboxEvent[] = [];
        if (isScheduled) {
          runtime.version = scheduledAt;
          const episode = runtime.faults.auth;
          if (!episode.warningCreated) {
            const warning = await faultEvent(
              "auth",
              episode.id,
              "warning",
              fixturePrefix(config.sourceName),
              now
            );
            episode.warningEventId = warning.id;
            episode.warningCreated = true;
            events.push(warning);
          }
        }
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: isScheduled ? "skipped" : "failed",
          errorKind: "auth-blocked",
          states: [{ key: "runtime", value: runtime, version: now }],
          events,
          usageChartSnapshots: []
        });
        return isScheduled ? "completed" : "failed";
      }

      let snapshot: QuotaSnapshot;
      let observedAt: number;
      try {
        snapshot = await fetchWithRetry(source, new Date(now), sleep);
        observedAt = validateSnapshot(snapshot);
      } catch (error) {
        const errorKind = classify(error);
        if (isScheduled) runtime.version = scheduledAt;
        const events: NewOutboxEvent[] = [];
        const prefix = fixturePrefix(config.sourceName);

        if (errorKind === "collector-disabled") {
          now = clock();
          await repo.commitSnapshotUnderLease({
            owner,
            now,
            jobKey,
            jobStatus: "skipped",
            errorKind,
            states: [{ key: "runtime", value: runtime, version: now }],
            events,
            usageChartSnapshots: []
          });
          return isScheduled ? "completed" : "failed";
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
            warningCreated: isScheduled,
            startedAt: scheduledAt
          };
          if (isScheduled) events.push(warning);
        } else if (errorKind === "schema") {
          if (isScheduled) runtime.transientRegularSlots = [];
          if (isScheduled && !runtime.faults.schema) {
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
          if (isScheduled) {
            appendTransientSlot(runtime, scheduledAt);
          }
          if (
            isScheduled &&
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

        now = clock();
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "failed",
          errorKind,
          states: [{ key: "runtime", value: runtime, version: now }],
          events,
          usageChartSnapshots: []
        });
        return isScheduled ? "completed" : "failed";
      }

      now = clock();
      if (scheduledNotAfter !== undefined && now >= scheduledNotAfter) {
        runtime.version = scheduledAt;
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "skipped",
          errorKind: "stale-slot",
          states: [{ key: "runtime", value: runtime, version: now }],
          events: [],
          usageChartSnapshots: []
        });
        return "completed";
      }

      const evaluation = evaluateSnapshot(previousQuota, snapshot, observedAt);
      let usageView: UsageDetailsView;
      try {
        const collected = await usageSource.fetch(observedAt);
        usageView = collected.status === "unavailable"
          ? { status: "unavailable", reason: collected.reason }
          : {
              status: "available",
              aggregate: aggregateUsage24h(
                collected.records,
                observedAt,
                collected.status === "truncated"
              )
            };
      } catch (error) {
        const reason: UsageUnavailableReason =
          error instanceof SourceError &&
          (
            error.kind === "auth" ||
            error.kind === "transient" ||
            error.kind === "schema"
          )
            ? error.kind
            : "transient";
        usageView = { status: "unavailable", reason };
      }

      now = clock();
      if (scheduledNotAfter !== undefined && now >= scheduledNotAfter) {
        runtime.version = scheduledAt;
        await repo.commitSnapshotUnderLease({
          owner,
          now,
          jobKey,
          jobStatus: "skipped",
          errorKind: "expired-slot",
          states: [
            { key: "quota", value: evaluation.state, version: now },
            { key: "runtime", value: runtime, version: now }
          ],
          events: [],
          usageChartSnapshots: []
        });
        return "completed";
      }

      const recoveryEvents: NewOutboxEvent[] = [];
      if (isScheduled) {
        const prefix = fixturePrefix(config.sourceName);
        for (const faultKind of FAULT_KINDS) {
          const episode = runtime.faults[faultKind];
          if (!episode) continue;
          if (
            episode.warningCreated &&
            await repo.isEventSucceeded(episode.warningEventId)
          ) {
            recoveryEvents.push(await faultEvent(
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
      }

      const logicalKey = broadcastLogicalKey(trigger);
      const manual = trigger.type === "manual";
      const notAfter = scheduledNotAfter ?? nextShanghaiHour(scheduledAt);
      const textOnlyEvent = await newEvent(
        "daily",
        logicalKey,
        (eventId) => renderBroadcastMessage(
          snapshot,
          eventId,
          manual,
          usageView
        ),
        notAfter,
        []
      );
      let targetEvent = textOnlyEvent;
      if (usageView.status === "available") {
        try {
          const chartUrl = await chartImagePublisher(
            usageView.aggregate,
            textOnlyEvent.id
          );
          if (!isPushPlusPictureUrl(chartUrl)) {
            throw new PushPlusImageError("upload", "invalid");
          }
          const richUsageView: UsageDetailsView = {
            status: "available",
            aggregate: usageView.aggregate,
            chartUrl
          };
          targetEvent = await newEvent(
            "daily",
            logicalKey,
            (eventId) => renderBroadcastMessage(
              snapshot,
              eventId,
              manual,
              richUsageView
            ),
            notAfter,
            []
          );
        } catch (error) {
          targetEvent = textOnlyEvent;
          const stage = error instanceof UsageChartPngError
            ? "png"
            : error instanceof PushPlusImageError
              ? error.stage
              : "publish";
          console.warn(JSON.stringify({
            event: "usage_chart_image_fallback",
            eventId: textOnlyEvent.id,
            stage
          }));
        }
      }

      const commitNow = clock();
      const commonCommit = {
        owner,
        now: commitNow,
        jobKey,
        jobStatus: "succeeded" as const,
        states: [
          { key: "quota", value: evaluation.state, version: commitNow },
          { key: "runtime", value: runtime, version: commitNow }
        ]
      };
      await repo.commitSnapshotUnderLease({
        ...commonCommit,
        events: [...recoveryEvents, targetEvent],
        usageChartSnapshots: []
      });
      const report = await dispatchDue(
        repo,
        config.pushplus,
        clock,
        fetchImpl
      );
      dispatchedAfterCommit = true;
      if (!isScheduled) {
        const targetSucceeded =
          report.acceptedEventIds.includes(targetEvent.id) ||
          await repo.isEventSucceeded(targetEvent.id);
        return targetSucceeded ? "completed" : "failed";
      }
      return "completed";
    } catch (error) {
      if (startedJobKey !== undefined) {
        try {
          await repo.markJob(startedJobKey, "failed", "internal");
        } catch {
          // 仅作尽力收尾，保留任务启动后的原始故障。
        }
      }
      throw error;
    } finally {
      await repo.releaseSnapshotLease(owner);
    }
  } finally {
    if (!dispatchedAfterCommit) {
      await dispatchDue(repo, config.pushplus, clock, fetchImpl);
    }
  }
  } finally {
    try {
      await repo.deleteExpiredUsageChartSnapshots(
        clock() - 30 * DAY_MS,
        200
      );
    } catch {
      console.warn(JSON.stringify({
        stage: "用量图表快照清理",
        category: "存储"
      }));
    }
  }
}
