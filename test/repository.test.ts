import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LeaseLostError, Repository } from "../src/repository";

describe("D1 repository", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_triggers"),
      env.DB.prepare("DELETE FROM outbox_attempts"),
      env.DB.prepare("DELETE FROM outbox_events"),
      env.DB.prepare("DELETE FROM runtime_state"),
      env.DB.prepare("DELETE FROM job_runs"),
      env.DB.prepare(
        "UPDATE locks SET owner = NULL, lease_until = 0 WHERE name = 'snapshot'"
      )
    ]);
  });

  it("allows one snapshot owner, one job, and one outbox claimant", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T01:00:00Z");

    expect(await repo.acquireSnapshotLease("owner-a", now, 90_000)).toBe(true);
    expect(await repo.acquireSnapshotLease("owner-b", now, 90_000)).toBe(false);
    expect(
      await repo.tryStartJob({
        key: "regular:1785728400000",
        kind: "regular",
        scheduledAt: now,
        startedAt: now
      })
    ).toBe(true);
    expect(
      await repo.tryStartJob({
        key: "regular:1785728400000",
        kind: "regular",
        scheduledAt: now,
        startedAt: now + 1
      })
    ).toBe(false);

    await repo.enqueueEventsUnderLease("owner-a", now, [
      {
        id: "event-1",
        logicalKey: "startup:first",
        kind: "startup",
        title: "title",
        content: "content",
        notAfter: now + 86_400_000,
        triggers: []
      }
    ]);

    const claims = await Promise.all([
      repo.claimDueEvent("dispatcher-a", now, 60_000),
      repo.claimDueEvent("dispatcher-b", now, 60_000)
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await repo.markAttemptFailure("event-1", 1, now + 1, now + 2);
    expect(
      await env.DB.prepare(
        "SELECT status, next_attempt_at FROM outbox_events WHERE id = 'event-1'"
      ).first()
    ).toEqual({ status: "retryable", next_attempt_at: now + 2 });
  });

  it("delivers accepted threshold triggers and abandons expired triggers", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T02:00:00Z");
    expect(await repo.acquireSnapshotLease("transition-owner", now, 90_000)).toBe(true);

    await repo.enqueueEventsUnderLease("transition-owner", now, [
      {
        id: "event-success",
        logicalKey: "threshold:success",
        kind: "threshold",
        title: "threshold title",
        content: "threshold content",
        notAfter: now + 86_400_000,
        triggers: [{
          window: "rolling",
          cycleKey: "rolling-cycle-success",
          threshold: 50,
          usedPercent: 55,
          resetAt: "2026-08-03T05:00:00Z"
        }]
      },
      {
        id: "event-expired",
        logicalKey: "threshold:expired",
        kind: "threshold",
        title: "expired title",
        content: "expired content",
        notAfter: now,
        triggers: [{
          window: "weekly",
          cycleKey: "weekly-cycle-expired",
          threshold: 75,
          usedPercent: 80,
          resetAt: "2026-08-10T00:00:00Z"
        }]
      }
    ]);

    const claim = await repo.claimDueEvent("dispatcher", now, 60_000);
    expect(claim).toMatchObject({ id: "event-success", attemptCount: 1 });
    expect(
      await env.DB.prepare(
        "SELECT status FROM outbox_attempts WHERE event_id = ? AND attempt_no = ?"
      ).bind("event-success", 1).first()
    ).toEqual({ status: "sending" });
    await repo.markAttemptAccepted("event-success", 1, "short-success", now + 1);
    expect(await Promise.all([
      repo.markCallbackSuccess("event-success", "short-success", now + 2),
      repo.markCallbackSuccess("event-success", "short-success", now + 2)
    ])).toEqual([true, true]);
    expect(await repo.markCallbackSuccess("event-success", "unknown", now + 3)).toBe(false);
    expect(await repo.markCallbackFailure(
      "event-success",
      "unknown",
      now + 3,
      now + 4
    )).toBe(false);
    await repo.expireDueEvents(now + 1);

    expect(
      await env.DB.prepare(
        "SELECT event_id, state FROM event_triggers ORDER BY event_id"
      ).all()
    ).toMatchObject({
      results: [
        { event_id: "event-expired", state: "abandoned" },
        { event_id: "event-success", state: "delivered" }
      ]
    });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM outbox_events WHERE id IN (?, ?) ORDER BY id"
      ).bind("event-expired", "event-success").all()
    ).toMatchObject({
      results: [
        { id: "event-expired", status: "expired" },
        { id: "event-success", status: "succeeded" }
      ]
    });
    expect(await repo.isEventSucceeded("event-success")).toBe(true);
    expect(await repo.isEventSucceeded("event-expired")).toBe(false);
  });

  it("commits state and events only under a live lease and finalizes a started job", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T03:00:00Z");
    expect(await repo.acquireSnapshotLease("commit-owner", now, 90_000)).toBe(true);
    expect(await repo.tryStartJob({
      key: "daily:commit",
      kind: "daily",
      scheduledAt: now,
      startedAt: now
    })).toBe(true);

    await repo.saveStateUnderLease(
      "commit-owner",
      "quota",
      { observation: "old" },
      1,
      now
    );
    await repo.commitSnapshotUnderLease({
      owner: "commit-owner",
      now: now + 1,
      jobKey: "daily:commit",
      jobStatus: "succeeded",
      states: [
        { key: "quota", value: { observation: "new" }, version: 2 },
        { key: "fault", value: { active: false }, version: 1 }
      ],
      events: [{
        id: "event-commit",
        logicalKey: "daily:commit",
        kind: "daily",
        title: "daily",
        content: "daily content",
        notAfter: now + 86_400_000,
        triggers: []
      }]
    });
    expect(await repo.loadState<{ observation: string }>("quota")).toEqual({
      observation: "new"
    });
    expect(await repo.loadState<{ active: boolean }>("fault")).toEqual({
      active: false
    });
    await repo.saveStateUnderLease(
      "commit-owner",
      "quota",
      { observation: "lower-version" },
      1,
      now + 1
    );
    expect(await repo.loadState<{ observation: string }>("quota")).toEqual({
      observation: "new"
    });
    expect(
      await env.DB.prepare(
        "SELECT status FROM job_runs WHERE job_key = 'daily:commit'"
      ).first()
    ).toEqual({ status: "succeeded" });

    await repo.markJob("daily:commit", "failed", "late-worker");
    expect(
      await env.DB.prepare(
        "SELECT status, error_kind FROM job_runs WHERE job_key = 'daily:commit'"
      ).first()
    ).toEqual({ status: "succeeded", error_kind: null });
    expect(await repo.tryStartJob({
      key: "regular:mark",
      kind: "regular",
      scheduledAt: now,
      startedAt: now
    })).toBe(true);
    await repo.markJob("regular:mark", "failed", "source");
    expect(
      await env.DB.prepare(
        "SELECT status, error_kind FROM job_runs WHERE job_key = 'regular:mark'"
      ).first()
    ).toEqual({ status: "failed", error_kind: "source" });

    await repo.releaseSnapshotLease("commit-owner");
    await repo.saveStateUnderLease(
      "commit-owner",
      "quota",
      { observation: "stale" },
      3,
      now + 2
    );
    expect(await repo.loadState<{ observation: string }>("quota")).toEqual({
      observation: "new"
    });
    expect(await repo.tryStartJob({
      key: "daily:lost-commit",
      kind: "daily",
      scheduledAt: now + 2,
      startedAt: now + 2
    })).toBe(true);
    await expect(repo.commitSnapshotUnderLease({
      owner: "commit-owner",
      now: now + 2,
      jobKey: "daily:lost-commit",
      jobStatus: "failed",
      errorKind: "lease-lost",
      states: [{ key: "lost-state", value: { persisted: false }, version: 1 }],
      events: [{
        id: "event-lost-commit",
        logicalKey: "threshold:lost-commit",
        kind: "threshold",
        title: "must not persist",
        content: "must not persist",
        notAfter: now + 86_400_000,
        triggers: [{
          window: "monthly",
          cycleKey: "lost-commit-cycle",
          threshold: 100,
          usedPercent: 100,
          resetAt: "2026-09-01T00:00:00Z"
        }]
      }]
    })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await repo.loadState("lost-state")).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM outbox_events WHERE id = 'event-lost-commit'"
      ).first()
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT status FROM job_runs WHERE job_key = 'daily:lost-commit'"
      ).first()
    ).toEqual({ status: "started" });
  });

  it("recovers stale deliveries, caps claims, and ignores an old failure callback", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T04:00:00Z");
    expect(await repo.acquireSnapshotLease("retry-owner", now, 90_000)).toBe(true);
    await repo.enqueueEventsUnderLease("retry-owner", now, [{
      id: "event-retry",
      logicalKey: "threshold:retry",
      kind: "threshold",
      title: "retry",
      content: "retry content",
      notAfter: now + 86_400_000,
      triggers: [{
        window: "monthly",
        cycleKey: "monthly-cycle-retry",
        threshold: 90,
        usedPercent: 95,
        resetAt: "2026-09-01T00:00:00Z"
      }]
    }]);

    expect(await repo.claimDueEvent("attempt-1", now, 60_000)).toMatchObject({
      id: "event-retry",
      attemptCount: 1
    });
    await repo.markAttemptAccepted("event-retry", 1, "short-old", now + 1);
    const callbackDeadline = now + 30 * 60 * 1000 + 1;
    await repo.requeueStaleDeliveries(callbackDeadline);
    expect(await repo.markCallbackFailure(
      "event-retry",
      "short-old",
      callbackDeadline + 1,
      callbackDeadline + 2
    )).toBe(true);
    expect(await repo.claimDueEvent(
      "attempt-2",
      callbackDeadline + 2,
      60_000
    )).toMatchObject({
      attemptCount: 2
    });
    expect(await repo.markCallbackFailure(
      "event-retry",
      "short-old",
      callbackDeadline + 3,
      callbackDeadline + 4
    )).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count FROM outbox_events WHERE id = 'event-retry'"
      ).first()
    ).toEqual({ status: "sending", attempt_count: 2 });

    await repo.markAttemptAccepted(
      "event-retry",
      2,
      "short-current",
      callbackDeadline + 4
    );
    expect(await repo.markCallbackFailure(
      "event-retry",
      "short-current",
      callbackDeadline + 5,
      callbackDeadline + 6
    )).toBe(true);
    expect(await repo.claimDueEvent(
      "attempt-3",
      callbackDeadline + 6,
      60_000
    )).toMatchObject({
      attemptCount: 3
    });
    await repo.requeueStaleDeliveries(callbackDeadline + 60_007);
    expect(await repo.claimDueEvent(
      "attempt-4",
      callbackDeadline + 60_008,
      60_000
    )).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count FROM outbox_events WHERE id = 'event-retry'"
      ).first()
    ).toEqual({ status: "dead", attempt_count: 3 });
    expect(
      await env.DB.prepare(
        "SELECT state FROM event_triggers WHERE event_id = 'event-retry'"
      ).first()
    ).toEqual({ state: "abandoned" });
  });
});
