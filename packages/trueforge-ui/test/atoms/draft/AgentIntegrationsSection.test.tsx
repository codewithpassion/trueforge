// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentIntegrationsSection } from '@/atoms/draft/AgentIntegrationsSection.js';
import type { IntegrationsPageProps } from '@/atoms/integrations/IntegrationsPage.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import type {
  AgentUIServer,
  IntegrationBase,
  ListIntegrationsParams,
  ListPermissionsResponse,
} from '@/server/types.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import {
  createMockAgentSessionsServer,
  createMockAgentUIServer,
  createMockIntegrationServer,
} from '../../server/mockServer.js';

const PENDING: IntegrationBase = {
  id: 'int-1',
  type: 'slack',
  status: 'pending',
  botDisplayName: 'release-bot',
  agentName: 'support-bot',
  allowedChannelIds: [],
  allowDirectMessages: true,
  approverUserIds: [],
  notificationRules: [],
};

const CONNECTED: IntegrationBase = { ...PENDING, id: 'int-2', status: 'connected', botDisplayName: 'help-bot' };

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

/** The page itself is covered by its own tests; here only what the drawer hands it matters. */
function StubIntegrationsPage({ agentId, embedded = false, initialIntegrationId }: IntegrationsPageProps) {
  return (
    <p data-testid="integrations-page">
      {`${agentId}${embedded ? ' embedded' : ''}${initialIntegrationId === undefined ? '' : ` on ${initialIntegrationId}`}`}
    </p>
  );
}

/** Puts the builder into update mode, as opening a saved agent for editing does. */
function SavedAgent({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { bindMutableAgent } = useShellMode();
  useEffect(() => {
    bindMutableAgent({ agentId, agentName, agentSpec: { model: { name: 'm' } } });
  }, [agentId, agentName, bindMutableAgent]);
  return null;
}

function withPermissions(permissions: ('MANAGE' | 'USE')[]): Partial<AgentUIServer> {
  return {
    permissions: {
      listPermissions: vi.fn(async (): Promise<ListPermissionsResponse> => ({
        data: { type: 'agent', permissions: { 'agent-1': permissions } },
      })),
    },
  };
}

function renderSection({ server, saved }: { server: AgentUIServer; saved?: { agentId: string; agentName: string } }) {
  const tree = (agent: typeof saved) => (
    <SlotsProvider overrides={{ IntegrationsPage: StubIntegrationsPage }}>
      <ServerProvider server={server}>
        <ShellModeProvider agentConfig={{ mode: 'AgentComposer' }}>
          {agent === undefined ? null : <SavedAgent agentId={agent.agentId} agentName={agent.agentName} />}
          <AgentIntegrationsSection />
        </ShellModeProvider>
      </ServerProvider>
    </SlotsProvider>
  );
  const view = render(tree(saved));
  return { ...view, switchAgent: (agent: { agentId: string; agentName: string }) => view.rerender(tree(agent)) };
}

function serverWith(
  listIntegrations: (req: ListIntegrationsParams) => Promise<IntegrationBase[]>,
  overrides: Partial<AgentUIServer> = {},
) {
  return createMockAgentUIServer({
    integrations: createMockIntegrationServer({ listIntegrations }),
    sessions: createMockAgentSessionsServer(),
    ...overrides,
  });
}

const SUPPORT_BOT = { agentId: 'agent-1', agentName: 'support-bot' };

describe('AgentIntegrationsSection', () => {
  it('renders nothing when the host has no integration server', () => {
    renderSection({ server: createMockAgentUIServer(), saved: SUPPORT_BOT });

    expect(screen.queryByRole('heading', { name: 'Integrations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing when the host serves integrations but no sessions port for the page', () => {
    const listIntegrations = vi.fn(async () => [PENDING]);
    renderSection({
      server: createMockAgentUIServer({ integrations: createMockIntegrationServer({ listIntegrations }) }),
      saved: SUPPORT_BOT,
    });

    expect(screen.queryByRole('heading', { name: 'Integrations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('asks to save a draft first and offers no action', () => {
    const listIntegrations = vi.fn(async () => [PENDING]);
    renderSection({ server: serverWith(listIntegrations) });

    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByText('Save the agent to connect Slack.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(listIntegrations).not.toHaveBeenCalled();
  });

  it("lists a saved agent's integrations with their status", async () => {
    const listIntegrations = vi.fn(async () => [PENDING, CONNECTED]);
    renderSection({ server: serverWith(listIntegrations), saved: SUPPORT_BOT });

    expect(await screen.findByRole('button', { name: /release-bot/ })).toHaveTextContent('Waiting for the Slack app');
    expect(screen.getByRole('button', { name: /help-bot/ })).toHaveTextContent('Connected');
    expect(listIntegrations).toHaveBeenCalledWith({ agentNames: ['support-bot'] });
  });

  it("opens the list from the action and a row's integration from the row", async () => {
    renderSection({ server: serverWith(async () => [PENDING, CONNECTED]), saved: SUPPORT_BOT });

    fireEvent.click(await screen.findByRole('button', { name: 'Manage integrations' }));
    const drawer = await screen.findByRole('dialog', { name: 'Integrations' });
    expect(within(drawer).getByTestId('integrations-page')).toHaveTextContent(/^agent-1 embedded$/);

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('integrations-page')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /help-bot/ }));
    expect(await screen.findByTestId('integrations-page')).toHaveTextContent(/^agent-1 embedded on int-2$/);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage integrations' }));
    expect(await screen.findByTestId('integrations-page')).toHaveTextContent(/^agent-1 embedded$/);
  });

  it('names the drawer by its visible title', async () => {
    renderSection({ server: serverWith(async () => [PENDING]), saved: SUPPORT_BOT });

    fireEvent.click(await screen.findByRole('button', { name: 'Manage integrations' }));

    expect(await screen.findByRole('dialog', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Manage integrations' })).not.toBeInTheDocument();
  });

  it('keeps the action disabled for a caller who cannot manage the agent', async () => {
    renderSection({ server: serverWith(async () => [PENDING], withPermissions(['USE'])), saved: SUPPORT_BOT });

    expect(await screen.findByRole('button', { name: /release-bot/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage integrations' })).toBeDisabled();
  });

  it('enables the action for a manager', async () => {
    renderSection({
      server: serverWith(async () => [PENDING], withPermissions(['USE', 'MANAGE'])),
      saved: SUPPORT_BOT,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Manage integrations' })).toBeEnabled();
    });
  });

  it('refreshes the list once the drawer closes', async () => {
    let stored = [PENDING];
    renderSection({ server: serverWith(async () => stored), saved: SUPPORT_BOT });

    fireEvent.click(await screen.findByRole('button', { name: 'Manage integrations' }));
    stored = [{ ...PENDING, status: 'connected' }];
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Integrations' })).getByRole('button', { name: 'Close' }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /release-bot/ })).toHaveTextContent('Connected');
    });
  });

  it("does not show a previous agent's late answer after switching agents", async () => {
    let answerFirst: (integrations: IntegrationBase[]) => void = () => undefined;
    const listIntegrations = vi.fn(({ agentNames }: ListIntegrationsParams) =>
      agentNames?.includes('agent-a') === true
        ? new Promise<IntegrationBase[]>(resolve => {
            answerFirst = resolve;
          })
        : Promise.resolve([{ ...CONNECTED, agentName: 'agent-b', botDisplayName: 'b-bot' }]),
    );
    const { switchAgent } = renderSection({
      server: serverWith(listIntegrations),
      saved: { agentId: 'id-a', agentName: 'agent-a' },
    });
    await waitFor(() => {
      expect(listIntegrations).toHaveBeenCalledWith({ agentNames: ['agent-a'] });
    });

    switchAgent({ agentId: 'id-b', agentName: 'agent-b' });
    expect(await screen.findByRole('button', { name: /b-bot/ })).toBeInTheDocument();
    await act(async () => {
      answerFirst([{ ...PENDING, agentName: 'agent-a', botDisplayName: 'a-bot' }]);
    });

    expect(screen.queryByRole('button', { name: /a-bot/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /b-bot/ })).toBeInTheDocument();
  });

  it("shows Loading… rather than the previous agent's rows while the next agent's list is pending", async () => {
    let answerB: (integrations: IntegrationBase[]) => void = () => undefined;
    const listIntegrations = vi.fn(({ agentNames }: ListIntegrationsParams) =>
      agentNames?.includes('agent-a') === true
        ? Promise.resolve([{ ...PENDING, agentName: 'agent-a', botDisplayName: 'a-bot' }])
        : new Promise<IntegrationBase[]>(resolve => {
            answerB = resolve;
          }),
    );
    const { switchAgent } = renderSection({
      server: serverWith(listIntegrations),
      saved: { agentId: 'id-a', agentName: 'agent-a' },
    });
    expect(await screen.findByRole('button', { name: /a-bot/ })).toBeInTheDocument();

    switchAgent({ agentId: 'id-b', agentName: 'agent-b' });
    await waitFor(() => {
      expect(listIntegrations).toHaveBeenCalledWith({ agentNames: ['agent-b'] });
    });

    expect(screen.queryByRole('button', { name: /a-bot/ })).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    await act(async () => {
      answerB([{ ...CONNECTED, agentName: 'agent-b', botDisplayName: 'b-bot' }]);
    });
    expect(screen.getByRole('button', { name: /b-bot/ })).toBeInTheDocument();
  });
});
