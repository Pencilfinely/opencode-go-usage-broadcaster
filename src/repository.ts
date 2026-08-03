import type { ThresholdItem } from "./rules";

export type EventKind =
  | "startup"
  | "threshold"
  | "daily"
  | "fault"
  | "recovery";

export interface NewOutboxEvent {
  id: string;
  logicalKey: string;
  kind: EventKind;
  title: string;
  content: string;
  notAfter: number;
  triggers: ThresholdItem[];
}

export interface ClaimedEvent {
  id: string;
  logicalKey: string;
  kind: EventKind;
  title: string;
  content: string;
  attemptCount: number;
  notAfter: number;
}

export interface JobInput {
  key: string;
  kind: "regular" | "daily";
  scheduledAt: number;
  startedAt: number;
}

export interface StateWrite {
  key: string;
  value: unknown;
  version: number;
}

export interface SnapshotCommit {
  owner: string;
  now: number;
  jobKey: string;
  jobStatus: "succeeded" | "failed" | "skipped";
  errorKind?: string;
  states: StateWrite[];
  events: NewOutboxEvent[];
}

export class LeaseLostError extends Error {
  constructor() {
    super("snapshot lease was lost before commit");
    this.name = "LeaseLostError";
  }
}

type EventRow = {
  id: string;
  logical_key: string;
  kind: EventKind;
  title: string;
  content: string;
  attempt_count: number;
  not_after: number;
};

type CallbackRow = {
  attempt_no: number;
  attempt_status: "sending" | "accepted" | "failed" | "succeeded" | "unknown";
  event_status:
    | "pending"
    | "sending"
    | "waiting_callback"
    | "retryable"
    | "succeeded"
    | "dead"
    | "expired";
  attempt_count: number;
};

export class Repository {
  constructor(private readonly db: D1Database) {}

  async acquireSnapshotLease(
    owner: string,
    now: number,
    leaseMs: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE locks SET owner = ?, lease_until = ? " +
        "WHERE name = 'snapshot' AND lease_until <= ?"
      )
      .bind(owner, now + leaseMs, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseSnapshotLease(owner: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE locks SET owner = NULL, lease_until = 0 " +
        "WHERE name = 'snapshot' AND owner = ?"
      )
      .bind(owner)
      .run();
  }

  async tryStartJob(job: JobInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO job_runs " +
        "(job_key, kind, scheduled_at, started_at, status) " +
        "VALUES (?, ?, ?, ?, 'started')"
      )
      .bind(job.key, job.kind, job.scheduledAt, job.startedAt)
      .run();
    return result.meta.changes === 1;
  }

  async loadState<T>(key: string): Promise<T | null> {
    const row = await this.db
      .prepare("SELECT value_json FROM runtime_state WHERE key = ?")
      .bind(key)
      .first<{ value_json: string }>();
    return row ? JSON.parse(row.value_json) as T : null;
  }

  async saveStateUnderLease<T>(
    owner: string,
    key: string,
    value: T,
    version: number,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO runtime_state (key, value_json, version, updated_at) " +
        "SELECT ?, ?, ?, ? WHERE EXISTS (" +
        "SELECT 1 FROM locks WHERE name = 'snapshot' " +
        "AND owner = ? AND lease_until > ?) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "value_json = excluded.value_json, version = excluded.version, " +
        "updated_at = excluded.updated_at " +
        "WHERE runtime_state.version < excluded.version AND EXISTS (" +
        "SELECT 1 FROM locks WHERE name = 'snapshot' " +
        "AND owner = ? AND lease_until > ?)"
      )
      .bind(
        key,
        JSON.stringify(value),
        version,
        now,
        owner,
        now,
        owner,
        now
      )
      .run();
  }

  async enqueueEventsUnderLease(
    owner: string,
    now: number,
    events: NewOutboxEvent[]
  ): Promise<void> {
    const statements = this.eventInsertStatements(owner, now, events);
    if (statements.length > 0) await this.db.batch(statements);
  }

  async commitSnapshotUnderLease(input: SnapshotCommit): Promise<void> {
    const guard =
      "EXISTS (SELECT 1 FROM locks WHERE name = 'snapshot' " +
      "AND owner = ? AND lease_until > ?)";
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "UPDATE locks SET lease_until = lease_until " +
          "WHERE name = 'snapshot' AND owner = ? AND lease_until > ?"
        )
        .bind(input.owner, input.now)
    ];

    for (const state of input.states) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO runtime_state (key, value_json, version, updated_at) " +
            "SELECT ?, ?, ?, ? WHERE " + guard + " " +
            "ON CONFLICT(key) DO UPDATE SET " +
            "value_json = excluded.value_json, version = excluded.version, " +
            "updated_at = excluded.updated_at " +
            "WHERE runtime_state.version < excluded.version AND " + guard
          )
          .bind(
            state.key,
            JSON.stringify(state.value),
            state.version,
            input.now,
            input.owner,
            input.now,
            input.owner,
            input.now
          )
      );
    }
    statements.push(...this.eventInsertStatements(
      input.owner,
      input.now,
      input.events
    ));
    statements.push(
      this.db
        .prepare(
          "UPDATE job_runs SET status = ?, error_kind = ? " +
          "WHERE job_key = ? AND status = 'started' AND " + guard
        )
        .bind(
          input.jobStatus,
          input.errorKind ?? null,
          input.jobKey,
          input.owner,
          input.now
        )
    );

    const results = await this.db.batch(statements);
    if (results[0]!.meta.changes !== 1) throw new LeaseLostError();
  }

  async markJob(
    jobKey: string,
    status: "succeeded" | "failed" | "skipped",
    errorKind?: string
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE job_runs SET status = ?, error_kind = ? " +
        "WHERE job_key = ? AND status = 'started'"
      )
      .bind(status, errorKind ?? null, jobKey)
      .run();
  }

  async claimDueEvent(
    owner: string,
    now: number,
    leaseMs: number
  ): Promise<ClaimedEvent | null> {
    await this.expireDueEvents(now);
    await this.requeueStaleDeliveries(now);
    const row = await this.db
      .prepare(
        "UPDATE outbox_events SET status = 'sending', lease_owner = ?, " +
        "lease_until = ?, attempt_count = attempt_count + 1, updated_at = ? " +
        "WHERE id = (SELECT id FROM outbox_events WHERE " +
        "status IN ('pending', 'retryable') AND attempt_count < 3 " +
        "AND next_attempt_at <= ? AND not_after > ? " +
        "AND (lease_until IS NULL OR lease_until <= ?) " +
        "ORDER BY created_at, id LIMIT 1) " +
        "RETURNING id, logical_key, kind, title, content, " +
        "attempt_count, not_after"
      )
      .bind(owner, now + leaseMs, now, now, now, now)
      .first<EventRow>();
    if (!row) return null;

    await this.db
      .prepare(
        "INSERT INTO outbox_attempts " +
        "(event_id, attempt_no, status, created_at, updated_at) " +
        "VALUES (?, ?, 'sending', ?, ?)"
      )
      .bind(row.id, row.attempt_count, now, now)
      .run();

    return {
      id: row.id,
      logicalKey: row.logical_key,
      kind: row.kind,
      title: row.title,
      content: row.content,
      attemptCount: row.attempt_count,
      notAfter: row.not_after
    };
  }

  async markAttemptAccepted(
    eventId: string,
    attemptNo: number,
    shortCode: string,
    now: number
  ): Promise<void> {
    const currentSending =
      "EXISTS (SELECT 1 FROM outbox_events WHERE id = ? " +
      "AND status = 'sending' AND attempt_count = ?)";
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO outbox_attempts " +
          "(event_id, attempt_no, provider_message_id, status, created_at, updated_at) " +
          "SELECT ?, ?, ?, 'accepted', ?, ? WHERE " + currentSending + " " +
          "ON CONFLICT(event_id, attempt_no) DO UPDATE SET " +
          "provider_message_id = excluded.provider_message_id, " +
          "status = 'accepted', updated_at = excluded.updated_at " +
          "WHERE outbox_attempts.status = 'sending' AND " + currentSending
        )
        .bind(
          eventId,
          attemptNo,
          shortCode,
          now,
          now,
          eventId,
          attemptNo,
          eventId,
          attemptNo
        ),
      this.db
        .prepare(
          "UPDATE outbox_events SET status = 'waiting_callback', " +
          "provider_message_id = ?, lease_owner = NULL, lease_until = NULL, " +
          "next_attempt_at = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'sending' AND attempt_count = ? " +
          "AND EXISTS (SELECT 1 FROM outbox_attempts WHERE event_id = ? " +
          "AND attempt_no = ? AND provider_message_id = ? AND status = 'accepted')"
        )
        .bind(
          shortCode,
          now + 30 * 60 * 1000,
          now,
          eventId,
          attemptNo,
          eventId,
          attemptNo,
          shortCode
        )
    ]);
  }

  async markAttemptFailure(
    eventId: string,
    attemptNo: number,
    now: number,
    retryAt: number
  ): Promise<void> {
    const currentSending =
      "EXISTS (SELECT 1 FROM outbox_events WHERE id = ? " +
      "AND status = 'sending' AND attempt_count = ?)";
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE outbox_attempts SET status = 'failed', updated_at = ? " +
          "WHERE event_id = ? AND attempt_no = ? AND status = 'sending' " +
          "AND " + currentSending
        )
        .bind(now, eventId, attemptNo, eventId, attemptNo),
      this.db
        .prepare(
          "UPDATE outbox_events SET status = CASE " +
          "WHEN attempt_count < 3 AND not_after > ? THEN 'retryable' " +
          "ELSE 'dead' END, lease_owner = NULL, lease_until = NULL, " +
          "next_attempt_at = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'sending' AND attempt_count = ?"
        )
        .bind(now, retryAt, now, eventId, attemptNo),
      this.db
        .prepare(
          "UPDATE event_triggers SET state = 'abandoned' " +
          "WHERE event_id = ? AND state = 'reserved' AND EXISTS (" +
          "SELECT 1 FROM outbox_events WHERE id = ? AND status = 'dead')"
        )
        .bind(eventId, eventId)
    ]);
  }

  async markCallbackSuccess(
    eventId: string,
    shortCode: string,
    now: number
  ): Promise<boolean> {
    const row = await this.callbackRow(eventId, shortCode);
    if (!row) return false;
    if (row.event_status === "succeeded") {
      return row.attempt_status === "succeeded";
    }
    if (!this.isActiveStatus(row.event_status)) return false;

    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE outbox_events SET status = 'succeeded', " +
          "lease_owner = NULL, lease_until = NULL, updated_at = ? " +
          "WHERE id = ? AND status IN " +
          "('pending', 'sending', 'waiting_callback', 'retryable') " +
          "AND EXISTS (SELECT 1 FROM outbox_attempts WHERE event_id = ? " +
          "AND provider_message_id = ?)"
        )
        .bind(now, eventId, eventId, shortCode),
      this.db
        .prepare(
          "UPDATE outbox_attempts SET status = 'succeeded', updated_at = ? " +
          "WHERE event_id = ? AND provider_message_id = ? AND EXISTS (" +
          "SELECT 1 FROM outbox_events WHERE id = ? AND status = 'succeeded')"
        )
        .bind(now, eventId, shortCode, eventId),
      this.db
        .prepare(
          "UPDATE event_triggers SET state = 'delivered' " +
          "WHERE event_id = ? AND state = 'reserved' AND EXISTS (" +
          "SELECT 1 FROM outbox_events WHERE id = ? AND status = 'succeeded')"
        )
        .bind(eventId, eventId)
    ]);
    if (results[0]!.meta.changes === 1) return true;
    const finalRow = await this.callbackRow(eventId, shortCode);
    return finalRow?.event_status === "succeeded" &&
      finalRow.attempt_status === "succeeded";
  }

  async markCallbackFailure(
    eventId: string,
    shortCode: string,
    now: number,
    retryAt: number
  ): Promise<boolean> {
    const row = await this.callbackRow(eventId, shortCode);
    if (!row || row.attempt_status === "succeeded" || row.event_status === "succeeded") {
      return false;
    }
    const mayChangeEvent =
      row.attempt_no === row.attempt_count &&
      (row.event_status === "sending" || row.event_status === "waiting_callback");
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE outbox_attempts SET status = 'failed', updated_at = ? " +
          "WHERE event_id = ? AND provider_message_id = ? " +
          "AND status <> 'succeeded'"
        )
        .bind(now, eventId, shortCode),
      this.db
        .prepare(
          "UPDATE outbox_events SET status = CASE " +
          "WHEN attempt_count < 3 AND not_after > ? THEN 'retryable' " +
          "ELSE 'dead' END, lease_owner = NULL, lease_until = NULL, " +
          "next_attempt_at = ?, updated_at = ? " +
          "WHERE id = ? AND attempt_count = ? " +
          "AND status IN ('sending', 'waiting_callback') " +
          "AND EXISTS (SELECT 1 FROM outbox_attempts WHERE event_id = ? " +
          "AND attempt_no = ? AND provider_message_id = ? AND status = 'failed')"
        )
        .bind(
          now,
          retryAt,
          now,
          eventId,
          row.attempt_no,
          eventId,
          row.attempt_no,
          shortCode
        ),
      this.db
        .prepare(
          "UPDATE event_triggers SET state = 'abandoned' " +
          "WHERE event_id = ? AND state = 'reserved' AND EXISTS (" +
          "SELECT 1 FROM outbox_events WHERE id = ? AND status = 'dead')"
        )
        .bind(eventId, eventId)
    ]);
    return results[0]!.meta.changes === 1 ||
      (row.attempt_status === "failed" && mayChangeEvent && results[1]!.meta.changes === 1);
  }

  async expireDueEvents(now: number): Promise<void> {
    const expiredActive =
      "SELECT id FROM outbox_events WHERE not_after <= ? " +
      "AND status IN ('pending', 'retryable', 'sending', 'waiting_callback')";
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE outbox_attempts SET status = 'unknown', updated_at = ? " +
          "WHERE status IN ('sending', 'accepted') AND event_id IN (" +
          expiredActive + ")"
        )
        .bind(now, now),
      this.db
        .prepare(
          "UPDATE outbox_events SET status = 'expired', " +
          "lease_owner = NULL, lease_until = NULL, updated_at = ? " +
          "WHERE not_after <= ? AND status IN " +
          "('pending', 'retryable', 'sending', 'waiting_callback')"
        )
        .bind(now, now),
      this.db
        .prepare(
          "UPDATE event_triggers SET state = 'abandoned' " +
          "WHERE state = 'reserved' AND event_id IN (" +
          "SELECT id FROM outbox_events WHERE status = 'expired')"
        )
    ]);
  }

  async requeueStaleDeliveries(now: number): Promise<void> {
    const stale =
      "SELECT id FROM outbox_events WHERE not_after > ? AND (" +
      "(status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?) " +
      "OR (status = 'waiting_callback' AND next_attempt_at <= ?))";
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE outbox_attempts SET status = 'unknown', updated_at = ? " +
          "WHERE status IN ('sending', 'accepted') AND event_id IN (" +
          stale + ") AND attempt_no = (SELECT attempt_count FROM outbox_events " +
          "WHERE id = outbox_attempts.event_id)"
        )
        .bind(now, now, now, now),
      this.db
        .prepare(
          "UPDATE outbox_events SET status = CASE " +
          "WHEN attempt_count < 3 THEN 'retryable' ELSE 'dead' END, " +
          "lease_owner = NULL, lease_until = NULL, next_attempt_at = ?, " +
          "updated_at = ? WHERE id IN (" + stale + ")"
        )
        .bind(now, now, now, now, now),
      this.db
        .prepare(
          "UPDATE event_triggers SET state = 'abandoned' " +
          "WHERE state = 'reserved' AND event_id IN (" +
          "SELECT id FROM outbox_events WHERE status = 'dead')"
        )
    ]);
  }

  async isEventSucceeded(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS succeeded FROM outbox_events WHERE id = ? AND status = 'succeeded'")
      .bind(eventId)
      .first<{ succeeded: number }>();
    return row?.succeeded === 1;
  }

  private eventInsertStatements(
    owner: string,
    now: number,
    events: NewOutboxEvent[]
  ): D1PreparedStatement[] {
    const guard =
      "EXISTS (SELECT 1 FROM locks WHERE name = 'snapshot' " +
      "AND owner = ? AND lease_until > ?)";
    return events.flatMap((event) => {
      const insertEvent = this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox_events " +
          "(id, logical_key, kind, title, content, status, next_attempt_at, " +
          "not_after, created_at, updated_at) " +
          "SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ? WHERE " + guard
        )
        .bind(
          event.id,
          event.logicalKey,
          event.kind,
          event.title,
          event.content,
          now,
          event.notAfter,
          now,
          now,
          owner,
          now
        );
      const triggerStatements = event.triggers.map((trigger) =>
        this.db
          .prepare(
            "INSERT OR IGNORE INTO event_triggers " +
            "(event_id, window_key, cycle_key, threshold, state) " +
            "SELECT ?, ?, ?, ?, 'reserved' WHERE " + guard + " " +
            "AND EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)"
          )
          .bind(
            event.id,
            trigger.window,
            trigger.cycleKey,
            trigger.threshold,
            owner,
            now,
            event.id
          )
      );
      return [insertEvent, ...triggerStatements];
    });
  }

  private callbackRow(eventId: string, shortCode: string): Promise<CallbackRow | null> {
    return this.db
      .prepare(
        "SELECT a.attempt_no, a.status AS attempt_status, " +
        "e.status AS event_status, e.attempt_count " +
        "FROM outbox_attempts a JOIN outbox_events e ON e.id = a.event_id " +
        "WHERE a.event_id = ? AND a.provider_message_id = ?"
      )
      .bind(eventId, shortCode)
      .first<CallbackRow>();
  }

  private isActiveStatus(status: CallbackRow["event_status"]): boolean {
    return status === "pending" || status === "sending" ||
      status === "waiting_callback" || status === "retryable";
  }
}
