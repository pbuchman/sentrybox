CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS project_ingest_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  environment TEXT NOT NULL CHECK (length(environment) > 0),
  public_key_hash BLOB NOT NULL UNIQUE CHECK (length(public_key_hash) = 32),
  cors_origins_json TEXT NOT NULL CHECK (
    json_valid(cors_origins_json) AND json_type(cors_origins_json) = 'array'
  ),
  forwarding_mode TEXT NOT NULL CHECK (forwarding_mode IN ('disabled', 'shadow')),
  forwarding_secret_ref TEXT,
  webhook_mode TEXT NOT NULL CHECK (webhook_mode IN ('disabled', 'live')),
  webhook_target_url TEXT,
  webhook_secret_ref TEXT,
  enabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, environment),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (
    (forwarding_mode = 'disabled') OR
    (forwarding_mode = 'shadow' AND forwarding_secret_ref IS NOT NULL AND length(forwarding_secret_ref) > 0)
  ),
  CHECK (
    (webhook_mode = 'disabled') OR
    (
      webhook_mode = 'live' AND
      webhook_target_url IS NOT NULL AND length(webhook_target_url) > 0 AND
      webhook_secret_ref IS NOT NULL AND length(webhook_secret_ref) > 0 AND
      enabled_at IS NOT NULL
    )
  )
) STRICT;

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  fingerprint_explanation_json TEXT NOT NULL CHECK (
    json_valid(fingerprint_explanation_json) AND json_type(fingerprint_explanation_json) = 'array'
  ),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unresolved', 'resolved')),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count BETWEEN 1 AND 9007199254740991),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  highest_level TEXT NOT NULL CHECK (highest_level IN ('warn', 'error', 'fatal')),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, project_id),
  UNIQUE (project_id, fingerprint_version, fingerprint),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (
    (status = 'unresolved' AND resolved_at IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL CHECK (length(event_id) > 0),
  issue_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  issue_generation INTEGER NOT NULL CHECK (issue_generation BETWEEN 1 AND 9007199254740991),
  environment TEXT NOT NULL CHECK (length(environment) > 0),
  release TEXT,
  service TEXT,
  level TEXT NOT NULL CHECK (level IN ('warn', 'error', 'fatal')),
  platform TEXT,
  title TEXT NOT NULL,
  message TEXT,
  exception_type TEXT,
  culprit TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  request_id TEXT,
  trace_id TEXT,
  task_id TEXT,
  fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  payload_gzip BLOB NOT NULL CHECK (length(payload_gzip) > 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  compressed_payload_bytes INTEGER NOT NULL CHECK (compressed_payload_bytes >= 0),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  UNIQUE (project_id, event_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id, project_id) REFERENCES issues(id, project_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS event_tags (
  event_row_id INTEGER NOT NULL,
  tag_key TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  PRIMARY KEY (event_row_id, tag_key),
  FOREIGN KEY (event_row_id) REFERENCES events(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS issue_facets (
  issue_id INTEGER NOT NULL,
  facet_type TEXT NOT NULL CHECK (facet_type IN ('environment', 'release', 'service', 'level')),
  facet_value TEXT NOT NULL,
  facet_value_is_null INTEGER NOT NULL CHECK (facet_value_is_null IN (0, 1)),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count BETWEEN 1 AND 9007199254740991),
  last_seen TEXT NOT NULL,
  PRIMARY KEY (issue_id, facet_type, facet_value, facet_value_is_null),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  CHECK (facet_value_is_null = 0 OR facet_value = '')
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE CHECK (length(delivery_id) > 0),
  project_id INTEGER NOT NULL,
  issue_id INTEGER NOT NULL,
  event_id TEXT NOT NULL CHECK (length(event_id) > 0),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  cause TEXT NOT NULL CHECK (cause IN ('created', 'regressed')),
  destination_mode TEXT NOT NULL CHECK (destination_mode IN ('disabled', 'live')),
  target_url TEXT,
  secret_ref TEXT,
  body BLOB NOT NULL CHECK (length(body) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'retry', 'delivered', 'dead_letter', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9007199254740991),
  next_attempt TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (issue_id, generation),
  FOREIGN KEY (issue_id, project_id) REFERENCES issues(id, project_id) ON DELETE CASCADE,
  CHECK (
    (
      destination_mode = 'disabled' AND state = 'suppressed' AND
      target_url IS NULL AND secret_ref IS NULL AND next_attempt IS NULL
    ) OR
    (
      destination_mode = 'live' AND state != 'suppressed' AND
      target_url IS NOT NULL AND length(target_url) > 0 AND
      secret_ref IS NOT NULL AND length(secret_ref) > 0
    )
  ),
  CHECK (
    (state IN ('pending', 'retry') AND next_attempt IS NOT NULL AND delivered_at IS NULL) OR
    (state = 'delivered' AND next_attempt IS NULL AND delivered_at IS NOT NULL) OR
    (state IN ('dead_letter', 'suppressed') AND next_attempt IS NULL AND delivered_at IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_issues_project_last_seen
  ON issues(project_id, last_seen DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_issues_project_status_last_seen
  ON issues(project_id, status, last_seen DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_events_issue_occurred
  ON events(issue_id, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_received
  ON events(project_id, received_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_environment_received
  ON events(project_id, environment, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_release_received
  ON events(project_id, release, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_service_received
  ON events(project_id, service, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_level_received
  ON events(project_id, level, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_tags_lookup
  ON event_tags(tag_key, tag_value, event_row_id);
CREATE INDEX IF NOT EXISTS idx_issue_facets_lookup
  ON issue_facets(facet_type, facet_value, facet_value_is_null, issue_id);
CREATE INDEX IF NOT EXISTS idx_outbox_dispatch
  ON webhook_outbox(state, next_attempt, id);
CREATE INDEX IF NOT EXISTS idx_outbox_issue_created
  ON webhook_outbox(issue_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS webhook_outbox_immutable_fields
BEFORE UPDATE ON webhook_outbox
WHEN
  OLD.delivery_id IS NOT NEW.delivery_id OR
  OLD.project_id IS NOT NEW.project_id OR
  OLD.issue_id IS NOT NEW.issue_id OR
  OLD.event_id IS NOT NEW.event_id OR
  OLD.generation IS NOT NEW.generation OR
  OLD.cause IS NOT NEW.cause OR
  OLD.destination_mode IS NOT NEW.destination_mode OR
  OLD.target_url IS NOT NEW.target_url OR
  OLD.secret_ref IS NOT NEW.secret_ref OR
  OLD.body IS NOT NEW.body OR
  OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'webhook outbox immutable fields cannot be changed');
END;
