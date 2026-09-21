// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeConfigFields } from '@/atoms/draft/AgentRuntimeConfigFields.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import type { AgentRuntimeConfig, ComputerBase, ComputerCatalogServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

async function unavailable(): Promise<never> {
  throw new Error('Unexpected computer catalog call');
}

function computer(overrides: Partial<ComputerBase> & { id: string; name: string }): ComputerBase {
  return {
    status: 'online',
    hostname: `${overrides.name}.local`,
    os: 'linux',
    arch: 'amd64',
    agentVersion: '0.1.0',
    tools: { python3: true, git: true },
    runAsUser: 'trueforge',
    requireApproval: true,
    lastSeenAt: '2026-09-21T10:00:00.000Z',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  };
}

const GRANTED = computer({ id: 'cmp-1', name: 'office-box' });
const UNGRANTED = computer({ id: 'cmp-2', name: 'other-box' });
const REVOKED = computer({ id: 'cmp-3', name: 'old-box', status: 'revoked' });
const OFFLINE = computer({ id: 'cmp-4', name: 'sleepy-box', status: 'offline' });

/** Puts the shell into the state a saved, editable agent leaves it in. */
function BindAgent({ agentName }: { agentName: string | undefined }) {
  const shell = useShellMode();
  useEffect(() => {
    if (agentName === undefined) {
      shell.openAgentBuilder();
      return;
    }
    shell.selectLibraryAgent({
      isMutable: true,
      isCreateAgent: true,
      agentId: 'agent-1',
      agentName,
      agentSpec: { model: { name: 'openai-main/gpt-4.1' } },
    });
    // Binding once on mount is the point; the shell setter identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);
  return null;
}

function renderFields({
  value,
  agentName,
  granted = {},
  computers,
  onChange = vi.fn(),
}: {
  value: AgentRuntimeConfig;
  agentName: string | undefined;
  granted?: Record<string, string[]>;
  computers?: ComputerBase[];
  onChange?: (next: AgentRuntimeConfig) => void;
}) {
  const computerCatalog: ComputerCatalogServer = {
    listComputers: async () => computers ?? [],
    createComputer: unavailable,
    getComputer: unavailable,
    updateComputer: unavailable,
    deleteComputer: unavailable,
    getComputerAgentAccess: async ({ computerId }) => granted[computerId] ?? [],
    putComputerAgentAccess: unavailable,
    rotateComputerEnrollment: unavailable,
    revokeComputer: unavailable,
    listComputerAudit: async () => ({ data: [] }),
  };
  const server = createMockAgentUIServer({
    catalog: createMockCatalog(computers === undefined ? {} : { computerCatalog }),
  });
  render(
    <ServerProvider server={server}>
      <ShellModeProvider>
        <BindAgent agentName={agentName} />
        <AgentRuntimeConfigFields
          value={value}
          sandboxAvailable
          hasSkills={false}
          layout="detailed"
          onChange={onChange}
        />
      </ShellModeProvider>
    </ServerProvider>,
  );
  return onChange;
}

describe('AgentComputerSelector', () => {
  it('renders nothing when the host has no computer catalog', () => {
    renderFields({ value: { sandbox: { enabled: true } }, agentName: 'release-bot' });

    expect(screen.queryByLabelText('Run on')).not.toBeInTheDocument();
  });

  it('offers only the computers this agent is granted, and never a revoked one', async () => {
    renderFields({
      value: { sandbox: { enabled: true } },
      agentName: 'release-bot',
      computers: [GRANTED, UNGRANTED, REVOKED],
      granted: { 'cmp-1': ['release-bot'], 'cmp-2': ['other-agent'], 'cmp-3': ['release-bot'] },
    });

    const select = await screen.findByLabelText('Run on');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /office-box/ })).toBeInTheDocument();
    });
    expect(select).toHaveValue('');
    expect(screen.queryByRole('option', { name: /other-box/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /old-box/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tenant sandbox (default)' })).toBeInTheDocument();
  });

  it('writes sandbox.computerId and keeps the other sandbox fields', async () => {
    const onChange = renderFields({
      value: { iterationLimit: 20, sandbox: { enabled: true, fileDownloads: false } },
      agentName: 'release-bot',
      computers: [GRANTED],
      granted: { 'cmp-1': ['release-bot'] },
    });

    await screen.findByRole('option', { name: /office-box/ });
    fireEvent.change(screen.getByLabelText('Run on'), { target: { value: 'cmp-1' } });

    expect(onChange).toHaveBeenCalledWith({
      iterationLimit: 20,
      sandbox: { enabled: true, fileDownloads: false, computerId: 'cmp-1' },
    });
  });

  it('drops the field again when the tenant sandbox is chosen', async () => {
    const onChange = renderFields({
      value: { sandbox: { enabled: true, fileDownloads: true, computerId: 'cmp-1' } },
      agentName: 'release-bot',
      computers: [GRANTED],
      granted: { 'cmp-1': ['release-bot'] },
    });

    await screen.findByRole('option', { name: /office-box/ });
    fireEvent.change(screen.getByLabelText('Run on'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ sandbox: { enabled: true, fileDownloads: true } });
  });

  it('keeps the chosen computer when the sandbox switch is toggled', async () => {
    const onChange = renderFields({
      value: { sandbox: { enabled: true, computerId: 'cmp-1' } },
      agentName: 'release-bot',
      computers: [GRANTED],
      granted: { 'cmp-1': ['release-bot'] },
    });

    fireEvent.click(await screen.findByRole('switch', { name: 'Sandbox' }));

    expect(onChange).toHaveBeenCalledWith({ sandbox: { enabled: false, computerId: 'cmp-1' } });
  });

  it('shows an offline computer as informational, not as a block', async () => {
    renderFields({
      value: { sandbox: { enabled: true, computerId: 'cmp-4' } },
      agentName: 'release-bot',
      computers: [OFFLINE],
      granted: { 'cmp-4': ['release-bot'] },
    });

    expect(await screen.findByRole('option', { name: /sleepy-box — sleepy-box\.local, offline/ })).toBeEnabled();
    expect(await screen.findByText(/offline right now\. It can still be saved/)).toBeInTheDocument();
    expect(screen.getByLabelText('Run on')).toBeEnabled();
  });

  it('tells an unsaved agent to be saved and granted first', async () => {
    renderFields({
      value: { sandbox: { enabled: true } },
      agentName: undefined,
      computers: [GRANTED],
      granted: { 'cmp-1': ['release-bot'] },
    });

    expect(await screen.findByText(/Save the agent first, then grant it a computer/)).toBeInTheDocument();
    expect(screen.getByLabelText('Run on')).toBeDisabled();
  });

  it('lets an unsaved draft put a stored computer back to the tenant sandbox', async () => {
    const onChange = renderFields({
      value: { sandbox: { enabled: true, computerId: 'cmp-1' } },
      agentName: undefined,
      computers: [GRANTED],
      granted: { 'cmp-1': ['release-bot'] },
    });

    const select = await screen.findByLabelText('Run on');
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ sandbox: { enabled: true } });
  });
});
