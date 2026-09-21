-- Delta for src/db/sqlite/migrations/20260921_000002_computer.ts, so D1 and better-sqlite3 hold
-- the same schema. Hand-written statement for statement from that migration: a D1 database is
-- deployed, so 0001_init.sql must not be regenerated with `pnpm d1:schema:dump`.
-- No table is rebuilt, so no `PRAGMA defer_foreign_keys` is needed.

CREATE TABLE computer (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) <= 128),
  owner_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (length(status) <= 16),
  credential_hash TEXT,
  hostname TEXT,
  os TEXT,
  arch TEXT,
  agent_version TEXT,
  capabilities BLOB,
  run_as_user TEXT,
  require_approval INTEGER NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id)
) STRICT;

CREATE UNIQUE INDEX computer_name_uq
  ON computer (tenant_id, name);

CREATE UNIQUE INDEX computer_credential_uq
  ON computer (credential_hash);

CREATE INDEX computer_tenant_idx
  ON computer (tenant_id, created_at);

CREATE TABLE computer_enrollment (
  code_hash TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (code_hash)
) STRICT;

CREATE INDEX computer_enrollment_computer_idx
  ON computer_enrollment (computer_id);

CREATE TABLE computer_agent_access (
  computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (computer_id, agent_name)
) STRICT;

CREATE INDEX computer_agent_access_agent_idx
  ON computer_agent_access (agent_name);

CREATE TABLE computer_audit (
  id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  op TEXT NOT NULL CHECK (length(op) <= 16),
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id)
) STRICT;

CREATE INDEX computer_audit_list_idx
  ON computer_audit (tenant_id, computer_id, id DESC);

CREATE INDEX computer_audit_created_idx
  ON computer_audit (created_at);
