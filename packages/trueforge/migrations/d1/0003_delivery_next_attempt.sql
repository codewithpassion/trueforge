-- Delta for src/db/sqlite/migrations/20260918_000003_delivery_next_attempt.ts, so D1 and
-- better-sqlite3 hold the same schema. Copied from a throwaway `pnpm d1:schema:dump`, which
-- writes the whole schema into 0001_init.sql and cannot be re-run to check this file.
-- No table is rebuilt, so no `PRAGMA defer_foreign_keys` is needed.

ALTER TABLE integration_delivery
  ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT '';

UPDATE integration_delivery SET next_attempt_at = updated_at;

DROP INDEX IF EXISTS integration_delivery_pending_idx;

CREATE INDEX integration_delivery_due_idx
  ON integration_delivery (next_attempt_at)
  WHERE status IN ('pending', 'sending');
