CREATE TABLE usage_chart_snapshots (
  id TEXT PRIMARY KEY
    REFERENCES outbox_events(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  chart_json TEXT NOT NULL CHECK (json_valid(chart_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX usage_chart_snapshots_created
ON usage_chart_snapshots (created_at, id);
