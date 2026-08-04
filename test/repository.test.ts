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
    const claim = claims.find((value) => value !== null)!;
    await repo.markAttemptFailure(
      "event-1",
      1,
      claim.leaseOwner,
      now + 1,
      now + 2
    );
    expect(
      await env.DB.prepare(
        "SELECT status, next_attempt_at FROM outbox_events WHERE id = 'event-1'"
      ).first()
    ).toEqual({ status: "retryable", next_attempt_at: now + 2 });
  });

  it("领取事件时在同一事务中创建对应投递尝试", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T01:30:00Z");
    expect(await repo.acquireSnapshotLease("trigger-owner", now, 90_000)).toBe(true);
    await repo.enqueueEventsUnderLease("trigger-owner", now, [{
      id: "event-trigger-claim",
      logicalKey: "startup:trigger-claim",
      kind: "startup",
      title: "title",
      content: "content",
      notAfter: now + 86_400_000,
      triggers: []
    }]);

    expect(
      await repo.claimDueEvent("dispatcher", now, 60_000)
    ).toMatchObject({
      id: "event-trigger-claim",
      attemptCount: 1,
      leaseOwner: "dispatcher"
    });

    expect(await env.DB.prepare(
      "SELECT attempt_no, status, created_at, updated_at FROM outbox_attempts " +
      "WHERE event_id = ?"
    ).bind("event-trigger-claim").first()).toEqual({
      attempt_no: 1,
      status: "sending",
      created_at: now,
      updated_at: now
    });
  });

  it("rolls back a claim when atomic attempt insertion conflicts", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T01:45:00Z");
    expect(await repo.acquireSnapshotLease("conflict-owner", now, 90_000)).toBe(true);
    await repo.enqueueEventsUnderLease("conflict-owner", now, [{
      id: "event-conflicting-claim",
      logicalKey: "startup:conflicting-claim",
      kind: "startup",
      title: "title",
      content: "content",
      notAfter: now + 86_400_000,
      triggers: []
    }]);
    await env.DB.prepare(
      "INSERT INTO outbox_attempts " +
      "(event_id, attempt_no, status, created_at, updated_at) " +
      "VALUES (?, 1, 'unknown', ?, ?)"
    ).bind("event-conflicting-claim", now, now).run();

    await expect(
      repo.claimDueEvent("dispatcher", now, 60_000)
    ).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT status, attempt_count, lease_owner, lease_until " +
      "FROM outbox_events WHERE id = ?"
    ).bind("event-conflicting-claim").first()).toEqual({
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_until: null
    });
  });

  it("接口接受后立即终结阈值事件并废弃过期触发条件", async () => {
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
    await repo.markAttemptAccepted(
      "event-success",
      1,
      "dispatcher",
      "short-success",
      now + 1
    );
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_events WHERE id = 'event-success'"
    ).first()).toEqual({ status: "succeeded" });
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_attempts WHERE event_id = 'event-success'"
    ).first()).toEqual({ status: "succeeded" });
    expect(await Promise.all([
      repo.markCallbackSuccess("event-success", "short-success", now + 2),
      repo.markCallbackSuccess("event-success", "short-success", now + 2)
    ])).toEqual([true, true]);
    expect(await repo.markCallbackFailure(
      "event-success",
      "short-success",
      now + 3,
      now + 4
    )).toBe(false);
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

  it("接口接受后即使超过有效期也拒绝失败回调", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T02:30:00Z");
    expect(await repo.acquireSnapshotLease("expiry-owner", now, 90_000)).toBe(true);
    await repo.enqueueEventsUnderLease("expiry-owner", now, [{
      id: "event-callback-expired",
      logicalKey: "threshold:callback-expired",
      kind: "threshold",
      title: "expires while waiting",
      content: "expires while waiting",
      notAfter: now + 10,
      triggers: [{
        window: "monthly",
        cycleKey: "callback-expired-cycle",
        threshold: 50,
        usedPercent: 55,
        resetAt: "2026-09-01T00:00:00Z"
      }]
    }]);

    expect(await repo.claimDueEvent("expiry-dispatcher", now, 60_000)).toMatchObject({
      id: "event-callback-expired",
      attemptCount: 1
    });
    await repo.markAttemptAccepted(
      "event-callback-expired",
      1,
      "expiry-dispatcher",
      "short-expired",
      now + 1
    );
    await repo.expireDueEvents(now + 10);

    expect(await repo.markCallbackFailure(
      "event-callback-expired",
      "short-expired",
      now + 11,
      now + 12
    )).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT status FROM outbox_events WHERE id = 'event-callback-expired'"
      ).first()
    ).toEqual({ status: "succeeded" });
    expect(
      await env.DB.prepare(
        "SELECT state FROM event_triggers WHERE event_id = 'event-callback-expired'"
      ).first()
    ).toEqual({ state: "delivered" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM outbox_attempts WHERE event_id = 'event-callback-expired'"
      ).first()
    ).toEqual({ status: "succeeded" });
  });

  it("接口接受后成功回调保持幂等", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T02:45:00Z");
    expect(await repo.acquireSnapshotLease("success-boundary-owner", now, 90_000))
      .toBe(true);
    await repo.enqueueEventsUnderLease("success-boundary-owner", now, [{
      id: "event-success-boundary",
      logicalKey: "threshold:success-boundary",
      kind: "threshold",
      title: "boundary title",
      content: "boundary content",
      notAfter: now + 10,
      triggers: [{
        window: "rolling",
        cycleKey: "success-boundary-cycle",
        threshold: 50,
        usedPercent: 55,
        resetAt: "2026-08-03T05:00:00Z"
      }]
    }]);
    const claim = await repo.claimDueEvent("success-boundary-dispatcher", now, 60_000);
    expect(claim).toMatchObject({ id: "event-success-boundary", attemptCount: 1 });
    await repo.markAttemptAccepted(
      "event-success-boundary",
      1,
      "success-boundary-dispatcher",
      "short-success-boundary",
      now + 1
    );

    expect(await repo.markCallbackSuccess(
      "event-success-boundary",
      "short-success-boundary",
      now + 10
    )).toBe(true);
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_events WHERE id = ?"
    ).bind("event-success-boundary").first()).toEqual({ status: "succeeded" });
    expect(await env.DB.prepare(
      "SELECT state FROM event_triggers WHERE event_id = ?"
    ).bind("event-success-boundary").first()).toEqual({ state: "delivered" });
  });

  it("接口接受后失败回调不能回退状态", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T02:47:00Z");
    expect(await repo.acquireSnapshotLease("failure-boundary-owner", now, 90_000))
      .toBe(true);
    await repo.enqueueEventsUnderLease("failure-boundary-owner", now, [{
      id: "event-failure-boundary",
      logicalKey: "threshold:failure-boundary",
      kind: "threshold",
      title: "boundary title",
      content: "boundary content",
      notAfter: now + 10,
      triggers: [{
        window: "weekly",
        cycleKey: "failure-boundary-cycle",
        threshold: 50,
        usedPercent: 55,
        resetAt: "2026-08-10T00:00:00Z"
      }]
    }]);
    await repo.claimDueEvent("failure-boundary-dispatcher", now, 60_000);
    await repo.markAttemptAccepted(
      "event-failure-boundary",
      1,
      "failure-boundary-dispatcher",
      "short-failure-boundary",
      now + 1
    );

    expect(await repo.markCallbackFailure(
      "event-failure-boundary",
      "short-failure-boundary",
      now + 10,
      now + 20
    )).toBe(false);
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_events WHERE id = ?"
    ).bind("event-failure-boundary").first()).toEqual({ status: "succeeded" });
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_attempts WHERE event_id = ?"
    ).bind("event-failure-boundary").first()).toEqual({ status: "succeeded" });
    expect(await env.DB.prepare(
      "SELECT state FROM event_triggers WHERE event_id = ?"
    ).bind("event-failure-boundary").first()).toEqual({ state: "delivered" });
  });

  it("requeues a matching claim at its lease boundary", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T02:50:00Z");
    expect(await repo.acquireSnapshotLease("stale-boundary-owner", now, 90_000))
      .toBe(true);
    await repo.enqueueEventsUnderLease("stale-boundary-owner", now, [{
      id: "event-stale-boundary",
      logicalKey: "startup:stale-boundary",
      kind: "startup",
      title: "boundary title",
      content: "boundary content",
      notAfter: now + 86_400_000,
      triggers: []
    }]);
    const claim = await repo.claimDueEvent("stale-dispatcher", now, 60_000);
    expect(claim).toMatchObject({
      id: "event-stale-boundary",
      attemptCount: 1,
      leaseOwner: "stale-dispatcher",
      leaseUntil: now + 60_000
    });

    expect(await repo.expireOrRequeueClaim(
      "event-stale-boundary",
      1,
      "stale-dispatcher",
      now + 60_000
    )).toBe(true);
    expect(await env.DB.prepare(
      "SELECT status, attempt_count, lease_owner, lease_until " +
      "FROM outbox_events WHERE id = ?"
    ).bind("event-stale-boundary").first()).toEqual({
      status: "retryable",
      attempt_count: 1,
      lease_owner: null,
      lease_until: null
    });
    expect(await env.DB.prepare(
      "SELECT status FROM outbox_attempts WHERE event_id = ? AND attempt_no = 1"
    ).bind("event-stale-boundary").first()).toEqual({ status: "unknown" });
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

  it("旧接口接受响应不能终结已被新租约领取的尝试", async () => {
    const repo = new Repository(env.DB);
    const now = Date.parse("2026-08-03T03:50:00Z");
    expect(await repo.acquireSnapshotLease("race-owner", now, 90_000)).toBe(true);
    await repo.enqueueEventsUnderLease("race-owner", now, [{
      id: "event-old-accept",
      logicalKey: "threshold:old-accept",
      kind: "threshold",
      title: "旧响应竞态",
      content: "旧响应不能覆盖新尝试",
      notAfter: now + 86_400_000,
      triggers: [{
        window: "monthly",
        cycleKey: "monthly-cycle-old-accept",
        threshold: 90,
        usedPercent: 95,
        resetAt: "2026-09-01T00:00:00Z"
      }]
    }]);

    expect(await repo.claimDueEvent("old-owner", now, 60_000)).toMatchObject({
      id: "event-old-accept",
      attemptCount: 1
    });
    await repo.requeueStaleDeliveries(now + 60_000);
    expect(await repo.claimDueEvent("new-owner", now + 60_000, 60_000))
      .toMatchObject({ id: "event-old-accept", attemptCount: 2 });

    expect(await repo.markAttemptAccepted(
      "event-old-accept",
      1,
      "old-owner",
      "short-old",
      now + 60_001
    )).toBe(false);
    expect(await env.DB.prepare(
      "SELECT status, attempt_count, lease_owner FROM outbox_events WHERE id = ?"
    ).bind("event-old-accept").first()).toEqual({
      status: "sending",
      attempt_count: 2,
      lease_owner: "new-owner"
    });
    expect(await env.DB.prepare(
      "SELECT attempt_no, status FROM outbox_attempts WHERE event_id = ? " +
      "ORDER BY attempt_no"
    ).bind("event-old-accept").all()).toMatchObject({
      results: [
        { attempt_no: 1, status: "unknown" },
        { attempt_no: 2, status: "sending" }
      ]
    });
    expect(await env.DB.prepare(
      "SELECT state FROM event_triggers WHERE event_id = ?"
    ).bind("event-old-accept").first()).toEqual({ state: "reserved" });
  });

  it("失败重试达到上限后不再领取事件", async () => {
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
    expect(await repo.markAttemptFailure(
      "event-retry",
      1,
      "attempt-1",
      now + 1,
      now + 2
    )).toBe(true);
    expect(await repo.claimDueEvent(
      "attempt-2",
      now + 2,
      60_000
    )).toMatchObject({
      attemptCount: 2
    });
    expect(await repo.markAttemptFailure(
      "event-retry",
      2,
      "attempt-2",
      now + 3,
      now + 4
    )).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count FROM outbox_events WHERE id = 'event-retry'"
      ).first()
    ).toEqual({ status: "retryable", attempt_count: 2 });
    expect(await repo.claimDueEvent(
      "attempt-3",
      now + 4,
      60_000
    )).toMatchObject({
      attemptCount: 3
    });
    await repo.requeueStaleDeliveries(now + 60_004);
    expect(await repo.claimDueEvent(
      "attempt-4",
      now + 60_005,
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
