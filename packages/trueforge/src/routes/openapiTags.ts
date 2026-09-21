/** Mintlify API Reference groups — the only OpenAPI `tags` values. */
export enum OpenApiTag {
  INTERNAL = 'Internal',
  AUTH = 'Auth',
  CAPABILITIES = 'Capabilities',
  MODELS = 'Models',
  MCP_SERVERS = 'MCP Servers',
  SKILLS = 'Skills',
  SANDBOXES = 'Sandboxes',
  COMPUTERS = 'Computers',
  AGENTS = 'Agents',
  SCHEDULES = 'Schedules',
  INTEGRATIONS = 'Integrations',
  AGENT_SESSIONS = 'Agent Sessions',
}

/** Document-level tag order for `/api/v1/docs` and Mintlify. */
export const OPENAPI_DOCUMENT_TAGS: { name: OpenApiTag }[] = [
  { name: OpenApiTag.INTERNAL },
  { name: OpenApiTag.AUTH },
  { name: OpenApiTag.CAPABILITIES },
  { name: OpenApiTag.MODELS },
  { name: OpenApiTag.MCP_SERVERS },
  { name: OpenApiTag.SKILLS },
  { name: OpenApiTag.SANDBOXES },
  { name: OpenApiTag.COMPUTERS },
  { name: OpenApiTag.AGENTS },
  { name: OpenApiTag.SCHEDULES },
  { name: OpenApiTag.INTEGRATIONS },
  { name: OpenApiTag.AGENT_SESSIONS },
];
