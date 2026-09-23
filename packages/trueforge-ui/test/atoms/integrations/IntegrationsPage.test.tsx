// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { IntegrationsPage } from '@/atoms/integrations/IntegrationsPage.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type {
  AgentUIServer,
  IntegrationBase,
  IntegrationServer,
  ListIntegrationsParams,
  ListPermissionsResponse,
  Schedule,
} from '@/server/types.js';
import {
  createMockAgentSessionsServer,
  createMockAgentUIServer,
  createMockIntegrationServer,
  createMockScheduleServer,
} from '../../server/mockServer.js';

const PENDING: IntegrationBase = {
  id: 'int-1',
  type: 'slack',
  status: 'pending',
  botDisplayName: 'release-bot',
  agentName: 'support-bot',
  allowedChannelIds: ['C0GENERAL'],
  allowDirectMessages: true,
  approverUserIds: [],
  notificationRules: [],
};

const CONNECTED: IntegrationBase = { ...PENDING, status: 'connected', externalAccountId: 'T0TEAM' };

const MANIFEST_JSON = JSON.stringify(
  { display_information: { name: 'TrueForge Bot' }, features: { bot_user: { display_name: 'trueforge-bot' } } },
  null,
  2,
);

/** Only the fields the rule picker reads; the real DTO carries cron, task and the rest. */
function schedule(name: string): Schedule {
  return {
    id: `sched-${name}`,
    name,
    agentId: 'agent-1',
    agentName: 'support-bot',
    task: 'report',
    cron: '0 0 * * *',
    timezone: 'UTC',
    status: 'active',
    lastRunAt: null,
    createdBySubject: { subjectId: 'admin-1', subjectType: 'user', subjectDisplayName: 'Admin One' },
  };
}

function renderSection(
  port: Partial<IntegrationServer> & { listIntegrations: (req: ListIntegrationsParams) => Promise<IntegrationBase[]> },
  serverOverrides: Partial<AgentUIServer> = {},
) {
  const integrations = createMockIntegrationServer({
    getIntegrationSetupManifest: async () => ({
      requestUrl: 'https://trueforge.test/api/v1/integrations/int-1/events',
      interactionsRequestUrl: 'https://trueforge.test/api/v1/integrations/int-1/interactions',
      manifestJson: MANIFEST_JSON,
      createAppUrl: 'https://api.slack.com/apps?new_app=1',
    }),
    ...port,
  });
  const server = createMockAgentUIServer({
    integrations,
    sessions: createMockAgentSessionsServer({
      getAgent: async ({ agentId }) => ({ agentId, name: 'support-bot', agentSpec: { model: { name: 'm' } } }),
    }),
    ...serverOverrides,
  });
  return render(
    <ServerProvider server={server}>
      <IntegrationsPage agentId="agent-1" />
    </ServerProvider>,
  );
}

/** The dialog opens once the page has resolved its agent's name. */
async function openAddDialog() {
  const add = await screen.findByRole('button', { name: /Add Slack workspace/ });
  await waitFor(() => {
    expect(add).toBeEnabled();
  });
  fireEvent.click(add);
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

describe('IntegrationsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an empty state when nothing is connected', async () => {
    renderSection({ listIntegrations: async () => [] });

    expect(await screen.findByText('No integrations yet.')).toBeInTheDocument();
  });

  it('lists an integration with the state it is in', async () => {
    renderSection({ listIntegrations: async () => [PENDING, { ...CONNECTED, id: 'int-2' }] });

    expect(await screen.findByText('Waiting for the Slack app')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it("lists only the page agent's integrations, by the name it resolved from the id", async () => {
    const listIntegrations = vi.fn(async (_req: ListIntegrationsParams) => [PENDING]);
    renderSection({ listIntegrations });

    expect(await screen.findByRole('button', { name: /release-bot/ })).toBeInTheDocument();
    expect(listIntegrations).toHaveBeenCalledWith({ agentNames: ['support-bot'] });
  });

  it('offers no agent picker: the page agent is the only owner', async () => {
    renderSection({ listIntegrations: async () => [] });

    await openAddDialog();

    expect(screen.getByLabelText('Bot name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Agent')).not.toBeInTheDocument();
  });

  it('creates a pending integration for the page agent from a bot name alone', async () => {
    const createIntegration = vi.fn(async () => PENDING);
    renderSection({ listIntegrations: async () => [], createIntegration });

    await openAddDialog();
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'release-bot' } });
    fireEvent.change(screen.getByLabelText('Allowed channels'), { target: { value: 'C0GENERAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createIntegration).toHaveBeenCalledWith({
        type: 'slack',
        agentName: 'support-bot',
        botDisplayName: 'release-bot',
        allowedChannelIds: ['C0GENERAL'],
        allowDirectMessages: true,
        approverUserIds: [],
        notificationRules: [],
      });
    });
  });

  it('sends a human-readable bot name as typed', async () => {
    const createIntegration = vi.fn(async () => PENDING);
    renderSection({ listIntegrations: async () => [], createIntegration });

    await openAddDialog();
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'TrueForge Bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createIntegration).toHaveBeenCalledWith(expect.objectContaining({ botDisplayName: 'TrueForge Bot' }));
    });
  });

  it("surfaces the server's own message when it refuses the bot name", async () => {
    // The slug rule lives on the server, so the form does not second-guess it.
    renderSection({
      listIntegrations: async () => [],
      createIntegration: async () => {
        throw new Error('The bot name must contain a letter or a digit.');
      },
    });

    await openAddDialog();
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: '???' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(/letter or a digit/)).toBeInTheDocument();
  });

  it('shows the bot handle the server derived, not one it computed', async () => {
    renderSection({ listIntegrations: async () => [PENDING] });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));

    expect(await screen.findByText(/The bot will appear in Slack as @trueforge-bot/)).toBeInTheDocument();
  });

  it('warns that renaming does not rename an app Slack already created', async () => {
    renderSection({ listIntegrations: async () => [CONNECTED] });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));

    expect(await screen.findByText(/keeps its name/)).toBeInTheDocument();
  });

  it('shows the app manifest, its request URL and where to paste it', async () => {
    renderSection({ listIntegrations: async () => [PENDING] });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));

    expect(await screen.findByText(/display_information/)).toBeInTheDocument();
    expect(
      screen.getByText('Request URL: https://trueforge.test/api/v1/integrations/int-1/events'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create the app in Slack/ })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps?new_app=1',
    );
  });

  it('copies the manifest to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderSection({ listIntegrations: async () => [PENDING] });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Copy manifest/ }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(MANIFEST_JSON);
    });
  });

  it('sends the credentials without any workspace or bot user id', async () => {
    const updateIntegration = vi.fn(async () => CONNECTED);
    renderSection({ listIntegrations: async () => [PENDING], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.change(await screen.findByLabelText('Bot user OAuth token'), { target: { value: 'xoxb-1' } });
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith({
        id: 'int-1',
        botDisplayName: 'release-bot',
        allowedChannelIds: ['C0GENERAL'],
        allowDirectMessages: true,
        approverUserIds: [],
        notificationRules: [],
        auth: { botToken: 'xoxb-1', signingSecret: 'secret' },
      });
    });
  });

  it('refuses to save one credential of the pair', async () => {
    const updateIntegration = vi.fn(async () => CONNECTED);
    renderSection({ listIntegrations: async () => [PENDING], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.change(await screen.findByLabelText('Bot user OAuth token'), { target: { value: 'xoxb-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Paste both/)).toBeInTheDocument();
    expect(updateIntegration).not.toHaveBeenCalled();
  });

  it('saves settings alone without touching the stored credentials', async () => {
    const updateIntegration = vi.fn(async () => CONNECTED);
    renderSection({ listIntegrations: async () => [CONNECTED], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.change(await screen.findByLabelText('Allowed channels'), { target: { value: 'C0GENERAL, C0RELEASES' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith({
        id: 'int-1',
        botDisplayName: 'release-bot',
        allowedChannelIds: ['C0GENERAL', 'C0RELEASES'],
        allowDirectMessages: true,
        approverUserIds: [],
        notificationRules: [],
      });
    });
  });

  it('reports what the server said when saving credentials fails', async () => {
    renderSection({
      listIntegrations: async () => [PENDING],
      updateIntegration: async () => {
        throw new Error('Slack rejected the bot token: invalid_auth');
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.change(await screen.findByLabelText('Bot user OAuth token'), { target: { value: 'xoxb-1' } });
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/invalid_auth/)).toBeInTheDocument();
  });

  it('disconnects and returns to the list', async () => {
    const deleteIntegration = vi.fn(async () => undefined);
    renderSection({ listIntegrations: async () => [CONNECTED], deleteIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(deleteIntegration).toHaveBeenCalledWith({ id: 'int-1' });
    });
    expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
  });
});

describe('IntegrationsPage approvals and notifications', () => {
  const WITH_RULE: IntegrationBase = {
    ...CONNECTED,
    approverUserIds: ['U0ADMIN'],
    notificationRules: [{ scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'failure' }],
  };

  it('shows the approver list and the rules that are stored', async () => {
    renderSection({ listIntegrations: async () => [WITH_RULE] });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));

    expect(await screen.findByLabelText('Who may approve')).toHaveValue('U0ADMIN');
    expect(screen.getByLabelText('Schedule')).toHaveValue('nightly-report');
    expect(screen.getByLabelText('Post to channel')).toHaveValue('C0RELEASES');
    expect(screen.getByLabelText('Post when')).toHaveValue('failure');
  });

  it('says so when nothing is set up yet', async () => {
    renderSection({ listIntegrations: async () => [CONNECTED] });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));

    expect(await screen.findByText('No notification rules.')).toBeInTheDocument();
  });

  it('sends an edited approver list', async () => {
    const updateIntegration = vi.fn(async () => WITH_RULE);
    renderSection({ listIntegrations: async () => [CONNECTED], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.change(await screen.findByLabelText('Who may approve'), { target: { value: 'U0ADMIN, U0LEAD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith(
        expect.objectContaining({ approverUserIds: ['U0ADMIN', 'U0LEAD'] }),
      );
    });
  });

  it('adds a rule and sends it', async () => {
    const updateIntegration = vi.fn(async () => WITH_RULE);
    renderSection({ listIntegrations: async () => [CONNECTED], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'nightly-report' } });
    fireEvent.change(screen.getByLabelText('Post to channel'), { target: { value: 'C0RELEASES' } });
    fireEvent.change(screen.getByLabelText('Post when'), { target: { value: 'failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationRules: [{ scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'failure' }],
        }),
      );
    });
  });

  it('removes a rule', async () => {
    const updateIntegration = vi.fn(async () => CONNECTED);
    renderSection({ listIntegrations: async () => [WITH_RULE], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove rule 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIntegration).toHaveBeenCalledWith(expect.objectContaining({ notificationRules: [] }));
    });
  });

  it('refuses to save a rule with only half of it filled in', async () => {
    const updateIntegration = vi.fn(async () => CONNECTED);
    renderSection({ listIntegrations: async () => [CONNECTED], updateIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'nightly-report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/both a schedule and a channel/)).toBeInTheDocument();
    expect(updateIntegration).not.toHaveBeenCalled();
  });

  it("offers the page agent's schedules, without demanding one of them", async () => {
    const listSchedules = vi.fn(async () => ({ data: [schedule('nightly-report'), schedule('weekly-digest')] }));
    renderSection(
      { listIntegrations: async () => [CONNECTED] },
      { schedules: createMockScheduleServer({ listSchedules }) },
    );

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));

    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map(option => option.getAttribute('value'))).toContain('nightly-report');
    expect(listSchedules).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['agent-1'] }));
    // Still a text box, so a schedule the host cannot list can be named by hand.
    expect(screen.getByLabelText('Schedule')).toHaveAttribute('list', 'integration-schedule-names');
  });
});

describe('IntegrationsPage permissions', () => {
  function permissionsFor(permissions: ('MANAGE' | 'USE')[]) {
    return {
      permissions: {
        listPermissions: vi.fn(async (): Promise<ListPermissionsResponse> => ({
          data: { type: 'agent', permissions: { 'agent-1': permissions } },
        })),
      },
    };
  }

  it('lets a manager add, save and disconnect', async () => {
    renderSection({ listIntegrations: async () => [CONNECTED] }, permissionsFor(['USE', 'MANAGE']));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Slack workspace/ })).toBeEnabled();
    });
    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('keeps add, save and disconnect disabled for a caller who only uses the agent', async () => {
    renderSection({ listIntegrations: async () => [CONNECTED] }, permissionsFor(['USE']));

    fireEvent.click(await screen.findByRole('button', { name: /release-bot/ }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByRole('button', { name: /Add Slack workspace/ })).toBeDisabled();
  });
});

describe('IntegrationsPage agent switch', () => {
  const FOR_A: IntegrationBase = { ...PENDING, id: 'int-a', agentName: 'agent-a', botDisplayName: 'a-bot' };
  const FOR_B: IntegrationBase = { ...PENDING, id: 'int-b', agentName: 'agent-b', botDisplayName: 'b-bot' };

  /** One server across rerenders, so only the page's agent changes between them. */
  function switchableServer(listIntegrations: IntegrationServer['listIntegrations']) {
    return createMockAgentUIServer({
      integrations: createMockIntegrationServer({ listIntegrations }),
      sessions: createMockAgentSessionsServer({
        getAgent: async ({ agentId }) => ({
          agentId,
          name: agentId === 'id-a' ? 'agent-a' : 'agent-b',
          agentSpec: { model: { name: 'm' } },
        }),
      }),
    });
  }

  it("keeps the next agent's integrations when the previous agent's list resolves last", async () => {
    const pending = new Map<string, (rows: IntegrationBase[]) => void>();
    const server = switchableServer(
      ({ agentNames }) =>
        new Promise(resolve => {
          pending.set(agentNames?.[0] ?? '', resolve);
        }),
    );
    const { rerender } = render(
      <ServerProvider server={server}>
        <IntegrationsPage agentId="id-a" />
      </ServerProvider>,
    );
    await waitFor(() => {
      expect(pending.has('agent-a')).toBe(true);
    });

    rerender(
      <ServerProvider server={server}>
        <IntegrationsPage agentId="id-b" />
      </ServerProvider>,
    );
    await waitFor(() => {
      expect(pending.has('agent-b')).toBe(true);
    });
    act(() => {
      pending.get('agent-b')?.([FOR_B]);
    });
    expect(await screen.findByRole('button', { name: /b-bot/ })).toBeInTheDocument();

    await act(async () => {
      pending.get('agent-a')?.([FOR_A]);
    });

    expect(screen.getByRole('button', { name: /b-bot/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /a-bot/ })).not.toBeInTheDocument();
  });

  it('closes an open Add dialog and drops what was typed when the agent changes', async () => {
    const server = switchableServer(async () => []);
    const { rerender } = render(
      <ServerProvider server={server}>
        <IntegrationsPage agentId="id-a" />
      </ServerProvider>,
    );
    await openAddDialog();
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'a-bot' } });

    rerender(
      <ServerProvider server={server}>
        <IntegrationsPage agentId="id-b" />
      </ServerProvider>,
    );

    // The native dialog stays mounted; closed means it has lost its `open` attribute.
    await waitFor(() => {
      expect(screen.getByLabelText('Bot name').closest('dialog')).not.toHaveAttribute('open');
    });
    await openAddDialog();
    expect(screen.getByLabelText('Bot name')).toHaveValue('');
  });

  it('leaves the open integration and its typed credentials behind when the agent changes', async () => {
    const server = switchableServer(async ({ agentNames }) => (agentNames?.[0] === 'agent-a' ? [FOR_A] : [FOR_B]));
    const { rerender } = render(
      <ServerProvider server={server}>
        <IntegrationsPage agentId="id-a" />
      </ServerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /a-bot/ }));
    fireEvent.change(await screen.findByLabelText('Bot user OAuth token'), { target: { value: 'xoxb-a' } });

    rerender(
      <ServerProvider server={server}>
        <IntegrationsPage agentId="id-b" />
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /b-bot/ }));
    expect(await screen.findByLabelText('Bot user OAuth token')).toHaveValue('');
  });
});
