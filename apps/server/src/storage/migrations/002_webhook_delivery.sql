ALTER TABLE webhook_outbox ADD COLUMN signature TEXT;
ALTER TABLE webhook_outbox ADD COLUMN dispatch_lease_id TEXT;
ALTER TABLE webhook_outbox ADD COLUMN dispatch_lease_until TEXT;
ALTER TABLE webhook_outbox ADD COLUMN environment TEXT;

UPDATE webhook_outbox
SET environment = (
  SELECT e.environment
  FROM events AS e
  WHERE e.project_id = webhook_outbox.project_id
    AND e.event_id = webhook_outbox.event_id
);

CREATE TABLE webhook_redrives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE CHECK (length(delivery_id) > 0),
  original_outbox_id INTEGER NOT NULL,
  target_url TEXT NOT NULL CHECK (length(target_url) > 0),
  secret_ref TEXT NOT NULL CHECK (length(secret_ref) > 0),
  signature TEXT NOT NULL CHECK (length(signature) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts IN (0, 1)),
  dispatch_lease_id TEXT,
  dispatch_lease_until TEXT,
  requested_at TEXT NOT NULL,
  attempted_at TEXT,
  last_error TEXT,
  FOREIGN KEY (original_outbox_id) REFERENCES webhook_outbox(id) ON DELETE CASCADE,
  CHECK (
    (state = 'pending' AND attempts = 0 AND attempted_at IS NULL) OR
    (state IN ('delivered', 'dead_letter') AND attempts = 1 AND attempted_at IS NOT NULL)
  ),
  CHECK (
    (dispatch_lease_id IS NULL AND dispatch_lease_until IS NULL) OR
    (
      state = 'pending' AND
      dispatch_lease_id IS NOT NULL AND length(dispatch_lease_id) > 0 AND
      dispatch_lease_until IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX idx_webhook_redrives_dispatch
  ON webhook_redrives(state, dispatch_lease_until, id);
CREATE INDEX idx_webhook_redrives_original
  ON webhook_redrives(original_outbox_id, requested_at DESC, id DESC);

CREATE TRIGGER webhook_outbox_v2_insert_guard
BEFORE INSERT ON webhook_outbox
WHEN
  (NEW.destination_mode = 'live' AND (NEW.signature IS NULL OR length(NEW.signature) != 64)) OR
  NEW.environment IS NULL OR length(NEW.environment) = 0 OR
  NEW.dispatch_lease_id IS NOT NULL OR
  NEW.dispatch_lease_until IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'webhook outbox v2 insert invariant failed');
END;

CREATE TRIGGER webhook_outbox_v2_update_guard
BEFORE UPDATE ON webhook_outbox
WHEN
  OLD.signature IS NOT NEW.signature OR
  OLD.environment IS NOT NEW.environment OR
  (
    (NEW.dispatch_lease_id IS NULL) != (NEW.dispatch_lease_until IS NULL)
  ) OR
  (
    NEW.dispatch_lease_id IS NOT NULL AND
    (length(NEW.dispatch_lease_id) = 0 OR NEW.state NOT IN ('pending', 'retry'))
  )
BEGIN
  SELECT RAISE(ABORT, 'webhook outbox v2 update invariant failed');
END;

CREATE TRIGGER webhook_redrives_immutable_fields
BEFORE UPDATE ON webhook_redrives
WHEN
  OLD.delivery_id IS NOT NEW.delivery_id OR
  OLD.original_outbox_id IS NOT NEW.original_outbox_id OR
  OLD.target_url IS NOT NEW.target_url OR
  OLD.secret_ref IS NOT NEW.secret_ref OR
  OLD.signature IS NOT NEW.signature OR
  OLD.requested_at IS NOT NEW.requested_at
BEGIN
  SELECT RAISE(ABORT, 'webhook redrive immutable fields cannot be changed');
END;
