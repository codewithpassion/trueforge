import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import type { AgentRecord } from '../../../src/db/agentStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import type { Database } from '../../../src/db/sqlite/types';

/** An agent to bind an integration to; the binding is a foreign key, so the row must exist. */
export function seedAgent(input: {
  db: Kysely<Database>;
  tenant_id: string;
  name: string;
  created_by_subject: CreatedBySubject;
}): Promise<AgentRecord> {
  return new SqliteAgentStore(input.db).createAgent({
    tenant_id: input.tenant_id,
    name: input.name,
    description: input.name,
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
    external_id: null,
    created_by_subject: input.created_by_subject,
  });
}
