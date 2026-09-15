/**
 * Result aliases that are `json(...)` projections of JSONB columns.
 * Plain TEXT (title, ids, timestamps) must not be parsed even when they look like JSON.
 */
const JSON_RESULT_COLUMNS = new Set([
  'agent_spec',
  'custom',
  'metadata',
  'metrics',
  'ancestor_ids',
  'input',
  'state',
  'checkpoint',
  'agent_info',
  'current_context_usage',
  'body',
  'capability_state',
  'turn_checkpoint',
  'turn_state',
  'thread_checkpoint',
  'event',
  'manifest',
  'build_metadata',
  'oauth_server',
  'oauth_client',
  'token',
  'auth_data',
  'created_by_subject',
  'source',
]);

/** Top-level row field only — `$[0]."body"`, not `$[0]."body"."content"`. */
export function shouldParseJsonResultColumn(_value: string, jsonPath: string): boolean {
  const match = /^\$\[\d+\]\."([^"]+)"$/.exec(jsonPath);
  const column = match?.[1];
  return column !== undefined && JSON_RESULT_COLUMNS.has(column);
}
