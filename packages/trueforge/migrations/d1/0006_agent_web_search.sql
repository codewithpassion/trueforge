-- Delta for src/db/sqlite/migrations/20260916_000001_agent_web_search.ts, so D1 and
-- better-sqlite3 hold the same data. Data only: no table or index changes.

UPDATE agent
SET manifest = jsonb_set(
  coalesce(manifest, jsonb('{}')),
  '$.config',
  jsonb_patch(
    coalesce(jsonb_extract(manifest, '$.config'), jsonb('{}')),
    jsonb('{"web_search":{"enabled":false}}')
  )
)
WHERE json_extract(manifest, '$.config.web_search') IS NULL;
