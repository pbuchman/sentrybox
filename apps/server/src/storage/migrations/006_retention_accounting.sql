CREATE TABLE retention_accounting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  logical_payload_bytes INTEGER NOT NULL CHECK (
    logical_payload_bytes BETWEEN 0 AND 9007199254740991
  ),
  mutation_revision INTEGER NOT NULL CHECK (
    mutation_revision BETWEEN 0 AND 9007199254740991
  ),
  reconciliation_revision INTEGER NOT NULL CHECK (
    reconciliation_revision BETWEEN -1 AND 9007199254740991
  ),
  reconciliation_max_event_id INTEGER NOT NULL CHECK (
    reconciliation_max_event_id BETWEEN 0 AND 9007199254740991
  ),
  reconciliation_cursor_id INTEGER NOT NULL CHECK (
    reconciliation_cursor_id BETWEEN -1 AND 9007199254740991
  ),
  reconciliation_payload_bytes INTEGER NOT NULL CHECK (
    reconciliation_payload_bytes BETWEEN 0 AND 9007199254740991
  )
) STRICT;

INSERT INTO retention_accounting(
  singleton, logical_payload_bytes, mutation_revision,
  reconciliation_revision, reconciliation_max_event_id,
  reconciliation_cursor_id, reconciliation_payload_bytes
)
SELECT 1, COALESCE(SUM(compressed_payload_bytes), 0), 0, -1, 0, -1, 0
FROM events;

CREATE TRIGGER retention_accounting_event_insert
AFTER INSERT ON events
BEGIN
  UPDATE retention_accounting
  SET logical_payload_bytes = logical_payload_bytes + NEW.compressed_payload_bytes,
      mutation_revision = mutation_revision + 1
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'retention accounting singleton is unavailable') END;
END;

CREATE TRIGGER retention_accounting_event_delete
AFTER DELETE ON events
BEGIN
  UPDATE retention_accounting
  SET logical_payload_bytes = logical_payload_bytes - OLD.compressed_payload_bytes,
      mutation_revision = mutation_revision + 1
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'retention accounting singleton is unavailable') END;
END;

CREATE TRIGGER retention_accounting_event_update
AFTER UPDATE OF compressed_payload_bytes, received_at ON events
WHEN
  OLD.compressed_payload_bytes IS NOT NEW.compressed_payload_bytes OR
  OLD.received_at IS NOT NEW.received_at
BEGIN
  UPDATE retention_accounting
  SET logical_payload_bytes =
        logical_payload_bytes - OLD.compressed_payload_bytes + NEW.compressed_payload_bytes,
      mutation_revision = mutation_revision + 1
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'retention accounting singleton is unavailable') END;
END;
