/**
 * The per-agent integration migration binds each row to the agent its manifest named. A row whose
 * agent is gone stops the upgrade instead: only an admin can say whether to recreate the agent or
 * drop the integration, and the old version is where either fix is still possible.
 */
export interface IntegrationAgentOrphan {
  id: string;
  tenant_id: string;
  /** The name the manifest carried; null when the manifest named none. */
  agent_name: string | null;
}

export function integrationAgentOrphanError(orphans: readonly IntegrationAgentOrphan[]): Error {
  const listed = orphans
    .map(orphan => `${orphan.id} (tenant ${orphan.tenant_id}, agent "${orphan.agent_name ?? ''}")`)
    .join(', ');
  return new Error(
    `Cannot bind integrations to their agents: ${String(orphans.length)} integration(s) name an agent that ` +
      `does not exist: ${listed}. On the previous TrueForge version, recreate each missing agent under that ` +
      'name or delete the integration in Settings > Integrations, then upgrade again.',
  );
}
