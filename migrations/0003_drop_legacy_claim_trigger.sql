DROP TRIGGER IF EXISTS outbox_claim_creates_attempt;

ALTER TABLE outbox_events ADD COLUMN claim_token TEXT;
