/** Durable Object name for everything scoped to one session: its turn runner and its workspace. */
export function sessionDurableObjectName(input: { tenant_id: string; session_id: string }): string {
  return `${input.tenant_id}:${input.session_id}`;
}
