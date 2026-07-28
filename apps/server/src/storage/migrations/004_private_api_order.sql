CREATE INDEX idx_issues_last_seen
  ON issues(last_seen DESC, id DESC);

CREATE INDEX idx_issues_status_last_seen
  ON issues(status, last_seen DESC, id DESC);

CREATE INDEX idx_events_export_order
  ON events(occurred_at, event_id, id);
