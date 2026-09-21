'use client';

import { useEffect, useState } from 'react';

import { useOptionalCatalogServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import type { AgentSandboxConfig, ComputerBase } from '../../server/types.js';
import { clientReportedText } from '../../utils/clientReportedText.js';
import { auiInputClass } from '../lib/inputClasses.js';

/** The tenant's own sandbox provider, which is what an agent uses when no computer is chosen. */
const TENANT_SANDBOX = '';

export type AgentComputerSelectorProps = {
  sandbox: AgentSandboxConfig | undefined;
  disabled: boolean;
  onChange: (computerId: string | undefined) => void;
};

/** The hostname is the machine's own text, so it is capped and stripped before it is shown. */
function describe(computer: ComputerBase): string {
  const where = computer.hostname === null ? 'no hostname yet' : clientReportedText(computer.hostname, 40);
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
  // A failed lookup is not an empty allowlist, and must never read as a grant that went away.
  const [failed, setFailed] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (computerCatalog === undefined || agentName === undefined) {
      setGranted([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
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
        if (cancelled) return;
        // The stored value is left alone: what this agent may use is now unknown, not gone.
        setGranted([]);
        setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [computerCatalog, agentName, epoch]);

  if (computerCatalog === undefined) return null;

  const offline = granted.find(computer => computer.id === selectedId && computer.status !== 'online');
  // The option has to exist whatever the lookup did, or the select would silently show
  // something other than what is stored.
  const storedMissing = selectedId !== undefined && !granted.some(computer => computer.id === selectedId);
  // Only once the lookup is in: neither a fetch in flight nor a failed one is evidence of a
  // grant that went away.
  const storedButUnavailable = storedMissing && !loading && !failed;

  function hint(): string {
    if (agentName === undefined) return 'Save the agent first, then grant it a computer in Settings → Computers.';
    if (loading) return 'Looking up which computers this agent may use…';
    if (failed) return 'Could not read which computers this agent may use. What is stored has been left alone.';
    if (storedButUnavailable) {
      return 'The saved computer is no longer granted to this agent; a turn will be refused until you pick another.';
    }
    if (granted.length === 0) return 'No computer has granted this agent access yet — do that in Settings → Computers.';
    if (offline !== undefined) {
      return 'That computer is offline right now. It can still be saved; a turn fails fast while it stays away.';
    }
    return 'Commands run on that machine, as its own user, instead of in a sandbox.';
  }

  return (
    <div className="mt-3 border-l-2 border-primary-button-bg/50 pl-3">
      <label htmlFor="agent-run-on" className="block text-xs font-medium text-text-primary">
        Run on
      </label>
      <select
        id="agent-run-on"
        value={selectedId ?? TENANT_SANDBOX}
        // An unsaved draft cannot pick a computer, but it must always be able to put one back.
        disabled={disabled || (agentName === undefined && selectedId === undefined)}
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
        {storedMissing ? (
          <option value={selectedId}>
            {storedButUnavailable ? `${selectedId} — no longer available to this agent` : selectedId}
          </option>
        ) : null}
      </select>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span>{hint()}</span>
        {failed ? (
          <button
            type="button"
            className="font-medium text-primary-button-bg hover:underline"
            onClick={() => {
              setEpoch(current => current + 1);
            }}
          >
            Try again
          </button>
        ) : null}
      </p>
    </div>
  );
}
