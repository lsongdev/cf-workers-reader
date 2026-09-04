CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  site_url TEXT,
  etag TEXT,
  last_modified TEXT,
  fetch_interval INTEGER NOT NULL DEFAULT 1800,
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  last_fetched_at INTEGER,
  last_success_at INTEGER,
  error_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  lease_token TEXT,
  fetching_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX feeds_due ON feeds(next_fetch_at, fetching_until);
CREATE TABLE feed_aliases (
  url TEXT PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE
);
CREATE TABLE subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  folder TEXT NOT NULL DEFAULT '',
  custom_title TEXT,
  read_before INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, feed_id)
);
CREATE INDEX subscriptions_feed ON subscriptions(feed_id);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(feed_id, guid)
);
CREATE INDEX items_feed_id ON items(feed_id, id);
CREATE TABLE item_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  read INTEGER CHECK(read IN (0, 1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0, 1)),
  PRIMARY KEY(user_id, item_id)
);
CREATE TABLE api_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
