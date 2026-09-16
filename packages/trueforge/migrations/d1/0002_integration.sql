-- Delta for src/db/sqlite/migrations/20260916_000001_integration.ts. Statements copied
-- from `pnpm d1:schema:dump` so D1 and better-sqlite3 hold the same schema.
-- No table is rebuilt, so no `PRAGMA defer_foreign_keys` is needed.

CREATE TABLE integration (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (length(type) <= 32),
  external_account_id TEXT NOT NULL,
  manifest BLOB NOT NULL,
  created_by_subject BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id)
) STRICT;

CREATE TABLE integration_event (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  integration_id TEXT NOT NULL REFERENCES integration (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (id)
) STRICT;

CREATE TABLE integration_delivery (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  integration_id TEXT NOT NULL REFERENCES integration (id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (length(status) <= 16),
  attempts INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id)
) STRICT;

CREATE UNIQUE INDEX integration_account_uq
  ON integration (tenant_id, type, external_account_id);

CREATE INDEX integration_list_idx
  ON integration (tenant_id, created_at, id);

CREATE UNIQUE INDEX integration_event_uq
  ON integration_event (integration_id, event_id);

CREATE INDEX integration_event_received_at_idx
  ON integration_event (received_at);

CREATE UNIQUE INDEX integration_delivery_turn_uq
  ON integration_delivery (turn_id);

CREATE INDEX integration_delivery_pending_idx
  ON integration_delivery (updated_at)
  WHERE status = 'pending';
