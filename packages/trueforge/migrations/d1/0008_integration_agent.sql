-- Delta for src/db/sqlite/migrations/20260923_000001_integration_agent.ts, so D1 and
-- better-sqlite3 hold the same schema.
--
-- Binds each integration to the agent `manifest.default_agent_name` names and removes that key.
-- An integration whose agent no longer exists stops this migration: the NOT NULL insert into
-- `integration_new` fails before anything is dropped. List those integrations with:
--
--   SELECT i.id, i.tenant_id, json_extract(i.manifest, '$.default_agent_name') AS agent_name
--   FROM integration AS i
--   LEFT JOIN agent AS a
--     ON a.tenant_id = i.tenant_id
--    AND a.name = json_extract(i.manifest, '$.default_agent_name')
--   WHERE a.id IS NULL;
--
-- then, on the previous version, recreate each missing agent or delete the integration.
--
-- D1 cannot turn foreign keys off, and dropping `integration` would cascade to its events,
-- deliveries and decisions, so those rows are set aside and restored around the rebuild.

PRAGMA defer_foreign_keys = true;

CREATE TABLE integration_new (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (length(type) <= 32),
  external_account_id TEXT NOT NULL,
  manifest BLOB NOT NULL,
  created_by_subject BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE CASCADE
) STRICT;

INSERT INTO integration_new (
  id,
  tenant_id,
  agent_id,
  agent_name,
  type,
  external_account_id,
  manifest,
  created_by_subject,
  created_at,
  updated_at
)
SELECT
  i.id,
  i.tenant_id,
  a.id,
  a.name,
  i.type,
  i.external_account_id,
  jsonb_remove(i.manifest, '$.default_agent_name'),
  i.created_by_subject,
  i.created_at,
  i.updated_at
FROM integration AS i
LEFT JOIN agent AS a
  ON a.tenant_id = i.tenant_id
 AND a.name = json_extract(i.manifest, '$.default_agent_name');

CREATE TABLE integration_event_keep AS SELECT * FROM integration_event;
CREATE TABLE integration_delivery_keep AS SELECT * FROM integration_delivery;
CREATE TABLE integration_decision_keep AS SELECT * FROM integration_decision;

DELETE FROM integration_event;
DELETE FROM integration_delivery;
DELETE FROM integration_decision;

DROP TABLE integration;
ALTER TABLE integration_new RENAME TO integration;

INSERT INTO integration_event SELECT * FROM integration_event_keep;
INSERT INTO integration_delivery SELECT * FROM integration_delivery_keep;
INSERT INTO integration_decision SELECT * FROM integration_decision_keep;

DROP TABLE integration_event_keep;
DROP TABLE integration_delivery_keep;
DROP TABLE integration_decision_keep;

CREATE UNIQUE INDEX integration_account_uq
  ON integration (tenant_id, type, external_account_id, agent_id);

CREATE INDEX integration_list_idx
  ON integration (tenant_id, created_at, id);

CREATE INDEX integration_agent_id_idx
  ON integration (tenant_id, agent_id);
