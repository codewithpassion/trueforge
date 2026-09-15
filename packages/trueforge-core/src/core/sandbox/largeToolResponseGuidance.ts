// Keep import-free so tool-response processing never loads the sandbox runtime.
export const SANDBOX_MCP_REMINDER_TAG = 'sandbox-mcp-code-mode';
export const SANDBOX_SCHEMA_INFER_TAG = 'sandbox-schema-infer';

export function createSandboxLargeToolResponseGuidance(): string {
  return `For use cases where the Agent needs a subset of fields from the MCP response or needs deterministic processing, write code with the provided MCP client and use <${SANDBOX_MCP_REMINDER_TAG}>.`;
}
