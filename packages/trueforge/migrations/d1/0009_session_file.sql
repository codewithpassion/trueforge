-- Delta for src/db/sqlite/migrations/20260923_000002_session_file.ts, so D1 and better-sqlite3
-- hold the same schema. A new table only, so no `PRAGMA defer_foreign_keys` is needed.

CREATE TABLE session_file (
  session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
) STRICT;
