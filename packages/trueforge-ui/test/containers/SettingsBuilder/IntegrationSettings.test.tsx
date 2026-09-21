// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import IntegrationSettings from '@/containers/SettingsBuilder/IntegrationSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { IntegrationBase, IntegrationCatalogServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

async function unavailable(): Promise<never> {
  throw new Error('Unexpected integration catalog call');
}

const PENDING: IntegrationBase = {
  id: 'int-1',
  type: 'slack',
  status: 'pending',
  botDisplayName: 'release-bot',
  defaultAgentName: 'support-bot',
  allowedChannelIds: ['C0GENERAL'],
  allowDirectMessages: true,
};

const CONNECTED: IntegrationBase = { ...PENDING, status: 'connected', externalAccountId: 'T0TEAM' };

const MANIFEST_JSON = JSON.stringify({ display_information: { name: 'release-bot' } }, null, 2);

function renderSection(
  catalog: Partial<IntegrationCatalogServer> & { listIntegrations: () => Promise<IntegrationBase[]> },
) {
  const integrationCatalog: IntegrationCatalogServer = {
    createIntegration: unavailable,
    updateIntegration: unavailable,
    deleteIntegration: unavailable,
    getIntegrationSetupManifest: async () => ({
      requestUrl: 'https://trueforge.test/api/v1/integrations/int-1/events',
      manifestJson: MANIFEST_JSON,
      createAppUrl: 'https://api.slack.com/apps?new_app=1',
    }),
    ...catalog,
  };
  const server = createMockAgentUIServer({ catalog: createMockCatalog({ integrationCatalog }) });
  return render(
    <ServerProvider server={server}>
      <IntegrationSettings />
    </ServerProvider>,
  );
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

describe('IntegrationSettings', () => {
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
    expect(screen.getAllByText('Answers as support-bot')).toHaveLength(2);
  });

  it('creates a pending integration from a bot name and an agent alone', async () => {
    const createIntegration = vi.fn(async () => PENDING);
    renderSection({ listIntegrations: async () => [], createIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /Add Slack workspace/ }));
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'release-bot' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'support-bot' } });
    fireEvent.change(screen.getByLabelText('Allowed channels'), { target: { value: 'C0GENERAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createIntegration).toHaveBeenCalledWith({
        type: 'slack',
        botDisplayName: 'release-bot',
        defaultAgentName: 'support-bot',
        allowedChannelIds: ['C0GENERAL'],
        allowDirectMessages: true,
      });
    });
  });

  it('says why a bot name Slack would refuse cannot be used, without calling the server', async () => {
    const createIntegration = vi.fn(async () => PENDING);
    renderSection({ listIntegrations: async () => [], createIntegration });

    fireEvent.click(await screen.findByRole('button', { name: /Add Slack workspace/ }));
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'Release Bot' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'support-bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(/lowercase letters/)).toBeInTheDocument();
    expect(createIntegration).not.toHaveBeenCalled();
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
        defaultAgentName: 'support-bot',
        allowedChannelIds: ['C0GENERAL'],
        allowDirectMessages: true,
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
        defaultAgentName: 'support-bot',
        allowedChannelIds: ['C0GENERAL', 'C0RELEASES'],
        allowDirectMessages: true,
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
