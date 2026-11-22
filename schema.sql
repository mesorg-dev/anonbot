CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  alias TEXT NOT NULL,
  hue INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  kind TEXT,
  notif_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  reply_text TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_notif ON messages (notif_id);
CREATE INDEX IF NOT EXISTS idx_messages_uid ON messages (uid, created_at);

CREATE TABLE IF NOT EXISTS banned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL UNIQUE,
  alias TEXT NOT NULL,
  hue INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
