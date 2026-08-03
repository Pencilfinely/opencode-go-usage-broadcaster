CREATE TRIGGER outbox_claim_creates_attempt
AFTER UPDATE OF status, attempt_count ON outbox_events
WHEN OLD.status IN ('pending', 'retryable')
  AND NEW.status = 'sending'
  AND NEW.attempt_count = OLD.attempt_count + 1
BEGIN
  INSERT INTO outbox_attempts (
    event_id,
    attempt_no,
    status,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.attempt_count,
    'sending',
    NEW.updated_at,
    NEW.updated_at
  );
END;
