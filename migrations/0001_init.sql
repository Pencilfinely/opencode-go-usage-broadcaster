PRAGMA foreign_keys = ON;

CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);

INSERT INTO locks (name, owner, lease_until)
VALUES ('snapshot', NULL, 0);

CREATE TABLE job_runs (
  job_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('regular', 'daily')),
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('started', 'succeeded', 'failed', 'skipped')
  ),
  error_kind TEXT
);

CREATE TABLE runtime_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (
    kind IN ('startup', 'threshold', 'daily', 'fault', 'recovery')
  ),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'sending',
      'waiting_callback',
      'retryable',
      'succeeded',
      'dead',
      'expired'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX outbox_due
ON outbox_events (status, next_attempt_at, lease_until);

CREATE TABLE outbox_attempts (
  event_id TEXT NOT NULL REFERENCES outbox_events(id),
  attempt_no INTEGER NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('sending', 'accepted', 'failed', 'succeeded', 'unknown')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, attempt_no)
);

CREATE TABLE event_triggers (
  event_id TEXT NOT NULL REFERENCES outbox_events(id),
  window_key TEXT NOT NULL CHECK (
    window_key IN ('rolling', 'weekly', 'monthly')
  ),
  cycle_key TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold IN (50, 75, 90, 100)),
  state TEXT NOT NULL CHECK (
    state IN ('reserved', 'delivered', 'abandoned')
  ),
  PRIMARY KEY (window_key, cycle_key, threshold)
);
