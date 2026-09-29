ALTER TABLE sessions ADD COLUMN rotation_id TEXT;

CREATE UNIQUE INDEX sessions_rotation_idx
  ON sessions(rotation_id)
  WHERE rotation_id IS NOT NULL;
