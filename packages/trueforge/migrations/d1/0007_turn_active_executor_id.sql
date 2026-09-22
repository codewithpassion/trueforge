-- Delta for src/db/sqlite/migrations/20260918_000001_turn_active_executor_id.ts, so D1 and
-- better-sqlite3 hold the same schema. The backfill differs on purpose: every D1 turn ran in
-- a SessionDO and its id has no `.executor` suffix, so the SQLite `substr(turn_id, ...)`
-- backfill would copy the whole id. The literal must equal WORKERS_EXECUTOR_ID in
-- src/workers/executorId.ts; tests/db/d1/executorIdMigration.test.ts checks the backfill.
-- No table is rebuilt, so no `PRAGMA defer_foreign_keys` is needed.

ALTER TABLE turn
  ADD COLUMN active_executor_id TEXT NOT NULL DEFAULT '';

UPDATE turn SET active_executor_id = 'session-do' WHERE active_executor_id = '';
