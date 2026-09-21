-- Delta for src/db/sqlite/migrations/20260921_000001_delivery_notification_target.ts, so D1 and
-- better-sqlite3 hold the same schema. Copied from a throwaway `pnpm d1:schema:dump`, which
-- writes the whole schema into 0001_init.sql and cannot be re-run to check this file.
-- No table is rebuilt, so no `PRAGMA defer_foreign_keys` is needed.

ALTER TABLE integration_delivery
  ADD COLUMN session_external_id TEXT NOT NULL DEFAULT '';

UPDATE integration_delivery SET session_external_id = conversation_key;

DROP INDEX IF EXISTS integration_delivery_turn_uq;

CREATE UNIQUE INDEX integration_delivery_target_uq
  ON integration_delivery (turn_id, conversation_key);
