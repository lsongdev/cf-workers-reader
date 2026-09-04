CREATE TABLE oidc_transactions (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oidc_transactions_expiry ON oidc_transactions(expires_at);
