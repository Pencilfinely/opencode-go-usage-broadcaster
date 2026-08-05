UPDATE outbox_attempts
SET status = 'unknown'
WHERE status IN ('sending', 'accepted')
  AND event_id IN (
    SELECT id
    FROM outbox_events
    WHERE kind IN ('startup', 'threshold', 'daily')
      AND status IN ('pending', 'sending', 'waiting_callback', 'retryable')
  );

UPDATE outbox_events
SET status = 'expired',
    lease_owner = NULL,
    lease_until = NULL,
    claim_token = '0004-expire-legacy-broadcast-events'
WHERE kind IN ('startup', 'threshold', 'daily')
  AND status IN ('pending', 'sending', 'waiting_callback', 'retryable');

UPDATE event_triggers
SET state = 'abandoned'
WHERE state = 'reserved'
  AND event_id IN (
    SELECT id
    FROM outbox_events
    WHERE claim_token = '0004-expire-legacy-broadcast-events'
  );

UPDATE outbox_events
SET claim_token = NULL
WHERE claim_token = '0004-expire-legacy-broadcast-events';
