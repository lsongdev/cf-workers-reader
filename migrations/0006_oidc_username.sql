ALTER TABLE users ADD COLUMN username TEXT;
CREATE INDEX users_username ON users(username);
