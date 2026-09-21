'use client';

import { useEffect, useState } from 'react';

import { useOptionalCatalogServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import type { AgentSandboxConfig, ComputerBase } from '../../server/types.js';
import { auiInputClass } from '../lib/inputClasses.js';

/** The tenant's own sandbox provider, which is what an agent uses when no computer is chosen. */
const TENANT_SANDBOX = '';

export type AgentComputerSelectorProps = {
  sandbox: AgentSandboxConfig | undefined;
  disabled: boolean;
  onChange: (computerId: string | undefined) => void;
};

function describe(computer: ComputerBase): string {
  const where = computer.hostname ?? 'no hostname yet';
  if (computer.status === 'online') return `${computer.name} — ${where}`;
  if (computer.status === 'offline') return `${computer.name} — ${where}, offline`;
  return `${computer.name} — ${where}, waiting to enroll`;
}

/**
 * "Run on": the tenant sandbox, or one of the computers this saved agent has been granted.
 * The server refuses any other computer, so only granted ones are offered.
 */
export function AgentComputerSelector({ sandbox, disabled, onChange }: AgentComputerSelectorProps) {
  const catalog = useOptionalCatalogServer();
  const shell = useOptionalShellMode();
  const computerCatalog = catalog?.computerCatalog;
  const agentName = shell?.mode.status === 'active' ? shell.mode.agentName : undefined;
  const selectedId = sandbox?.computerId;

  const [granted, setGranted] = useState<ComputerBase[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (computerCatalog === undefined || agentName === undefined) {
      setGranted([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const computers = await computerCatalog.listComputers();
        // The allowlist lives per computer, so "which may this agent use" is asked of each one.
        const usable = computers.filter(computer => computer.status !== 'revoked');
        const access = await Promise.all(
          usable.map(async computer => ({
            computer,
            names: await computerCatalog.getComputerAgentAccess({ computerId: computer.id }),
          })),
        );
        if (!cancelled) {
          setGranted(access.filter(entry => entry.names.includes(agentName)).map(entry => entry.computer));
        }
      } catch {
        // A picker that cannot list leaves the stored value alone rather than clearing it.
        if (!cancelled) setGranted([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [computerCatalog, agentName]);

  if (computerCatalog === undefined) return null;

  const offline = granted.find(computer => computer.id === selectedId && computer.status !== 'online');
  const storedButUnavailable = selectedId !== undefined && !granted.some(computer => computer.id === selectedId);

  return (
    <div className="mt-3 border-l-2 border-primary-button-bg/50 pl-3">
      <label htmlFor="agent-run-on" className="block text-xs font-medium text-text-primary">
        Run on
      </label>
      <select
        id="agent-run-on"
        value={selectedId ?? TENANT_SANDBOX}
        disabled={disabled || agentName === undefined}
        className={auiInputClass('mt-1 h-8 disabled:opacity-60')}
        onChange={event => {
          onChange(event.target.value === TENANT_SANDBOX ? undefined : event.target.value);
        }}
      >
        <option value={TENANT_SANDBOX}>Tenant sandbox (default)</option>
        {granted.map(computer => (
          <option key={computer.id} value={computer.id}>
            {describe(computer)}
          </option>
        ))}
        {storedButUnavailable ? (
          <option value={selectedId}>{selectedId} — no longer available to this agent</option>
        ) : null}
      </select>
      <p className="mt-1 text-xs text-text-secondary">
        {agentName === undefined
          ? 'Save the agent first, then grant it a computer in Settings → Computers.'
          : loading
            ? 'Looking up which computers this agent may use…'
            : granted.length === 0
              ? 'No computer has granted this agent access yet — do that in Settings → Computers.'
              : storedButUnavailable
                ? 'The saved computer is no longer granted to this agent; a turn will be refused until you pick another.'
                : offline === undefined
                  ? 'Commands run on that machine, as its own user, instead of in a sandbox.'
                  : 'That computer is offline right now. It can still be saved; a turn fails fast while it stays away.'}
      </p>
    </div>
  );
}
