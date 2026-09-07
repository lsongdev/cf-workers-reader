CREATE TABLE scheduler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO scheduler_state(id) VALUES (1);
