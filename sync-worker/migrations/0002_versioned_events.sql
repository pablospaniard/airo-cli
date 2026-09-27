CREATE TABLE sync_events_versioned (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  version TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('history', 'feedback', 'jev-feedback', 'tombstone')),
  repository_id TEXT,
  created_at INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  UNIQUE (user_id, kind, event_id, version),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE
);

INSERT INTO sync_events_versioned(
  cursor, user_id, event_id, version, device_id, kind, repository_id, created_at, envelope
)
SELECT
  cursor, user_id, event_id, 'legacy:' || cursor, device_id, kind, repository_id, created_at, envelope
FROM sync_events;

DROP TABLE sync_events;
ALTER TABLE sync_events_versioned RENAME TO sync_events;
CREATE INDEX sync_events_user_cursor_idx ON sync_events(user_id, cursor);
