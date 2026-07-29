CREATE INDEX idx_events_retention_received
  ON events(received_at, id);

CREATE INDEX idx_outbox_retention_delivered
  ON webhook_outbox(delivered_at, id)
  WHERE state = 'delivered';

CREATE INDEX idx_webhook_redrives_retention_terminal
  ON webhook_redrives(attempted_at, id)
  WHERE state IN ('delivered', 'dead_letter');
