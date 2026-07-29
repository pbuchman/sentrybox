CREATE INDEX idx_webhook_outbox_due_frontier
  ON webhook_outbox(next_attempt, id)
  WHERE state IN ('pending', 'retry');
