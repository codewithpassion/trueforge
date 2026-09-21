-- Delta for src/db/sqlite/migrations/20260921_000001_delivery_notification_target.ts, so D1 and
-- better-sqlite3 hold the same schema. Copied from a throwaway `pnpm d1:schema:dump`, which
-- writes the whole schema into 0001_init.sql and cannot be re-run to check this file.
-- No table is rebuilt, so no `PRAGMA defer_foreign_keys` is needed.

ALTER TABLE integration_delivery
  ADD COLUMN session_external_id TEXT NOT NULL DEFAULT '';

UPDATE integration_delivery SET session_external_id = conversation_key;

DROP INDEX IF EXISTS integration_delivery_turn_uq;

CREATE UNIQUE INDEX integration_delivery_target_uq
  ON integration_delivery (integration_id, turn_id, conversation_key);

CREATE TABLE integration_decision (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  integration_id TEXT NOT NULL REFERENCES integration (id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  decided_by_id TEXT NOT NULL,
  decided_by_display_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (length(decision) <= 16),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (id)
) STRICT;

CREATE UNIQUE INDEX integration_decision_turn_uq
  ON integration_decision (integration_id, turn_id);

CREATE INDEX integration_decision_list_idx
  ON integration_decision (tenant_id, integration_id, decided_at);
