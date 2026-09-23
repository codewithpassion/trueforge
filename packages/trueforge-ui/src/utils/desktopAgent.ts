import type { AgentSpec } from '../server/types.js';

/** The computer whose desktop an agent drives, or undefined when it drives none. */
export function desktopComputerId(spec: AgentSpec | undefined): string | undefined {
  const sandbox = spec?.config?.sandbox;
  if (sandbox?.desktop !== true) return undefined;
  const computerId = sandbox.computerId;
  return computerId === undefined || computerId === '' ? undefined : computerId;
}
