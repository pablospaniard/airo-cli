-- Supports idempotent refresh-token rotation retries.
--
-- `rotated_from` links a rotation's successor row back to the row it
-- replaced (distinct from the existing unique `rotation_id` guard, which
-- stays unique per row and cannot be shared) so a retry can find the
-- still-live successor of an already-rotated token.
--
-- `request_id_hash` records the hash of the client-supplied rotationRequestId
-- that consumed a row, so a retry presenting the same rotationRequestId can
-- be recognized as the same logical attempt rather than an independent
-- (and possibly malicious) reuse of the same refresh token.
ALTER TABLE sessions ADD COLUMN rotated_from TEXT;
ALTER TABLE sessions ADD COLUMN request_id_hash TEXT;

CREATE INDEX sessions_rotated_from_idx ON sessions(rotated_from);
