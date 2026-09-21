/**
 * The one place that decides whether an agent may use a computer. Spec validation, the capability
 * endpoint and the turn all ask through here, so none of them can admit what another refuses.
 */
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { SandboxUsability, SandboxUsabilityReason } from '../sandbox/integration';
import type { ComputerRelayStatus } from './protocol';
import { RemoteComputerProvider } from './RemoteComputerProvider';
import type { ComputersService } from './service';

function refuse(reason: SandboxUsability['reason']): SandboxUsability {
  return { usable: false, status: undefined, reason };
}

/** What a caller is told when a computer cannot run this agent's work. */
export function computerNotUsableMessage({
  computerId,
  reason,
}: {
  computerId: string;
  reason: SandboxUsabilityReason | undefined;
}): string {
  switch (reason) {
    case 'unknown_computer':
    case undefined:
      return `Unknown computer "${computerId}"`;
    case 'computer_revoked':
      return `Computer "${computerId}" has been revoked`;
    case 'agent_not_allowed':
      return `This agent is not allowed to use computer "${computerId}" — an admin grants access per computer`;
    case 'inline_agent':
      return 'A computer is granted to a saved agent: save the agent first, then have an admin grant it access';
    case 'computers_disabled':
      return 'Remote computers are not available on this server';
    case 'computer_offline':
      return `Computer "${computerId}" is offline`;
    case 'computer_no_skills':
      return `Computer "${computerId}" cannot mount skills: it needs python3, git and the pydantic package`;
  }
}

export interface ComputerSelection {
  computer_id: string;
  /**
   * The saved agent's immutable id. `undefined` is an inline agent, which can never be granted a
   * machine. Never the name: any tenant user can create an agent, so a name-keyed grant would let
   * one of them take over a grant meant for someone else's agent.
   */
  agent_id: string | undefined;
  tenant_id: string;
  /** Whether the spec asks for skills. A machine that cannot mount them may still run commands. */
  skills_requested: boolean;
}

/**
 * An agent may use a computer when the computer is in its tenant, is not revoked, and the agent is
 * on its allowlist. Being offline is not a refusal — a machine someone owns is asleep most of the
 * time — so it comes back `usable` with a reason the turn reports instead.
 */
export async function resolveComputerUsability({
  computers,
  selection,
}: {
  computers: ComputersService | undefined;
  selection: ComputerSelection;
}): Promise<SandboxUsability> {
  if (computers === undefined) {
    return refuse('computers_disabled');
  }
  // An inline spec has no identity to put on an allowlist, so it can never be granted a machine.
  if (selection.agent_id === undefined) {
    return refuse('inline_agent');
  }
  const computer = await computers.store.getComputer({
    tenant_id: selection.tenant_id,
    computer_id: selection.computer_id,
  });
  // A computer in another tenant reads exactly like one that does not exist.
  if (computer === undefined) {
    return refuse('unknown_computer');
  }
  if (computer.status === 'revoked') {
    return refuse('computer_revoked');
  }
  const allowed = await computers.store.isAgentAllowed({
    tenant_id: selection.tenant_id,
    computer_id: selection.computer_id,
    agent_id: selection.agent_id,
  });
  if (!allowed) {
    return refuse('agent_not_allowed');
  }
  // Only refused once the machine has said what it has: a computer that has never connected is
  // still worth saving an agent for, and the turn checks again against the live hello.
  if (selection.skills_requested && computer.capabilities !== null && !computer.capabilities.skills) {
    return refuse('computer_no_skills');
  }
  return computer.status === 'online'
    ? { usable: true, status: 'ready', reason: undefined }
    : { usable: true, status: 'ready', reason: 'computer_offline' };
}

/**
 * Builds the provider for a computer the caller has already had cleared. Returns undefined when the
 * computer is gone, so the caller answers the same way it does for a missing sandbox provider.
 */
export async function buildRemoteComputerProvider({
  computers,
  tenantId,
  computerId,
  sessionId,
  turnId,
  defaultExecTimeoutSeconds,
  fileMaxBytesForDownload,
  logger,
}: {
  computers: ComputersService;
  tenantId: string;
  computerId: string;
  sessionId: string;
  turnId: string | null;
  defaultExecTimeoutSeconds: number;
  fileMaxBytesForDownload: number;
  logger: Logger;
}): Promise<RemoteComputerProvider | undefined> {
  const computer = await computers.store.getComputer({ tenant_id: tenantId, computer_id: computerId });
  if (computer === undefined || computer.status === 'revoked') {
    return undefined;
  }
  const relay = computers.relay(computerId);
  // The relay holds what the machine said when it connected, which is the only source for its
  // sessions root: nothing in the row can stand in for a path on someone else's filesystem.
  let live: ComputerRelayStatus | undefined;
  try {
    live = await relay.status();
  } catch (error) {
    logger.debug('Could not read a computer relay; using the stored machine facts', {
      computer_id: computerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const hello = live?.hello ?? null;
  return new RemoteComputerProvider({
    relay,
    computerId,
    computerName: computer.name,
    tenantId,
    sessionId,
    turnId,
    workdir: hello?.workdir ?? null,
    capabilities: hello?.capabilities ?? computer.capabilities,
    defaultExecTimeoutSeconds,
    fileMaxBytesForDownload,
    store: computers.store,
    logger,
  });
}
