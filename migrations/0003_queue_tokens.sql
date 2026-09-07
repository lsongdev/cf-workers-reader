ALTER TABLE feeds ADD COLUMN queue_token TEXT;
ALTER TABLE feeds ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX feeds_queue ON feeds(queued_at);
