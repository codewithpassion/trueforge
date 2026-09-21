// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import SandboxSettings from '@/containers/SettingsBuilder/SandboxSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type {
  CreateSandboxProviderRequest,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderListEntry,
  SandboxSnapshotSyncStatus,
  UpdateSandboxProviderRequest,
} from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const catalogEntry: SandboxProviderCatalogEntry = {
  id: 'cat-daytona',
  name: 'Daytona',
  type: 'daytona',
  execTimeoutMs: 300000,
  autoStopIntervalInMinutes: 15,
  autoArchiveIntervalInMinutes: 10080,
  autoDeleteIntervalInMinutes: 43200,
};

function sandboxEntry({
  provider,
  status = 'ready',
  statusReason,
}: {
  provider: SandboxProviderBase;
  status?: SandboxSnapshotSyncStatus['status'];
  statusReason?: string;
}): SandboxProviderListEntry {
  return {
    data: provider,
    snapshotSyncStatus: {
      status,
      ...(statusReason ? { statusReason } : {}),
    },
  };
}

/** What a Workers deploy with the built-in sandbox available offers: no Daytona, no settings. */
const builtInCatalogEntry: SandboxProviderCatalogEntry = {
  id: 'cloudflare-computer',
  name: 'Cloudflare Computer',
  type: 'cloudflare-computer',
  execTimeoutMs: 0,
  autoStopIntervalInMinutes: 0,
  autoArchiveIntervalInMinutes: 0,
  autoDeleteIntervalInMinutes: 0,
};

const builtInProvider: SandboxProviderBase = {
  id: 'cloudflare-computer',
  name: 'Cloudflare Computer',
  catalogId: 'cloudflare-computer',
  isConnected: true,
  execTimeoutMs: 0,
  autoStopIntervalInMinutes: 0,
  autoArchiveIntervalInMinutes: 0,
  autoDeleteIntervalInMinutes: 0,
};

function createFakeHost(
  initial: SandboxProviderListEntry[] = [],
  options: { catalog?: SandboxProviderCatalogEntry[]; withDelete?: boolean } = {},
) {
  let providers = [...initial];
  let listCalls = 0;
  const created: CreateSandboxProviderRequest[] = [];
  const updated: UpdateSandboxProviderRequest[] = [];
  const deleted: string[] = [];

  const sandboxCatalog = {
    ...(options.withDelete === true
      ? {
          deleteSandboxProvider: async ({ id }: { id: string }) => {
            deleted.push(id);
            providers = providers.filter(entry => entry.data.id !== id);
          },
        }
      : {}),
    getSandboxProviderCatalog: async () => options.catalog ?? [catalogEntry],
    listSandboxProviders: async () => {
      listCalls += 1;
      return providers;
    },
    createSandboxProvider: async (req: CreateSandboxProviderRequest) => {
      created.push(req);
      const provider: SandboxProviderBase = {
        id: `sb-${req.catalogId}`,
        name: req.name,
        catalogId: req.catalogId,
        isConnected: true,
        execTimeoutMs: req.execTimeoutMs,
        autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
        autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
        autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
      };
      providers = [...providers, sandboxEntry({ provider, status: 'pending' })];
      return provider;
    },
    updateSandboxProvider: async (req: UpdateSandboxProviderRequest) => {
      updated.push(req);
      providers = providers.map(entry =>
        entry.data.id === req.id
          ? {
              ...entry,
              data: {
                ...entry.data,
                execTimeoutMs: req.execTimeoutMs,
                autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
                autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
                autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
              },
            }
          : entry,
      );
      const next = providers.find(entry => entry.data.id === req.id);
      if (next === undefined) {
        throw new Error(`Sandbox provider "${req.id}" not found`);
      }
      return next.data;
    },
  };

  const server = createMockAgentUIServer({
    catalog: createMockCatalog({ sandboxCatalog }),
  });

  return {
    created,
    updated,
    deleted,
    getListCalls: () => listCalls,
    getProviders: () => providers,
    setProviders: (next: SandboxProviderListEntry[]) => {
      providers = next;
    },
    wrapper: ({ children }: { children: ReactNode }) => <ServerProvider server={server}>{children}</ServerProvider>,
  };
}

describe('SandboxSettings', () => {
  it('autofills create form from catalog except apiKey', async () => {
    const host = createFakeHost();
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Daytona')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Advanced settings/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }));
    expect(screen.getByLabelText('Exec timeout (ms)')).toHaveProperty('value', '300000');
    expect(screen.getByLabelText('Auto-stop interval (minutes)')).toHaveProperty('value', '15');
    expect(screen.getByLabelText('Auto-archive interval (minutes)')).toHaveProperty('value', '10080');
    expect(screen.getByLabelText('Auto-delete interval (minutes)')).toHaveProperty('value', '43200');
    expect(screen.getByLabelText('API key')).toHaveProperty('value', '');

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'dtn_secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(host.created).toHaveLength(1);
    });
    expect(host.created[0]).toMatchObject({
      catalogId: 'cat-daytona',
      name: 'Daytona',
      type: 'daytona',
      execTimeoutMs: 300000,
      autoStopIntervalInMinutes: 15,
      autoArchiveIntervalInMinutes: 10080,
      autoDeleteIntervalInMinutes: 43200,
      apiKey: 'dtn_secret',
    });
  });

  it('prefills update form and allows saving without re-entering apiKey', async () => {
    const existing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([sandboxEntry({ provider: existing })]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Advanced settings/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }));
    expect(screen.getByLabelText('Exec timeout (ms)')).toHaveProperty('value', '60000');
    expect(screen.getByLabelText('Auto-stop interval (minutes)')).toHaveProperty('value', '30');
    expect(screen.getByLabelText(/API key/)).toHaveProperty('value', '');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(host.updated).toHaveLength(1);
    });
    expect(host.updated[0]).toEqual({
      id: 'sb-1',
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    });
    expect(host.updated[0]).not.toHaveProperty('apiKey');
  });

  it('hides other catalog providers once one is configured', async () => {
    const existing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([sandboxEntry({ provider: existing })]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Sandbox providers')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
    // Once a provider is configured, the whole "Available" section is hidden (heading + message).
    expect(screen.queryByText(/^Available ·/)).toBeNull();
    expect(screen.queryByText('One provider is set up. Update it or remove it to switch.')).toBeNull();
  });

  it('renders pending and ready snapshot status badges', async () => {
    const provider: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([
      sandboxEntry({
        provider,
        status: 'pending',
        statusReason: 'Snapshot build is queued',
      }),
      sandboxEntry({
        provider: { ...provider, id: 'sb-2', name: 'Daytona ready' },
        status: 'ready',
      }),
    ]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Syncing image...')).toBeTruthy();
      expect(screen.getByText('Connected')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    fireEvent.mouseEnter(screen.getByLabelText('Snapshot sync status details'));
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Snapshot build is queued');
    });
  });

  it('polls pending snapshot status every ten seconds until it changes', async () => {
    vi.useFakeTimers();
    const provider: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([sandboxEntry({ provider, status: 'pending' })]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.getListCalls()).toBe(1);

    host.setProviders([sandboxEntry({ provider, status: 'ready' })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(host.getListCalls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(host.getListCalls()).toBe(2);
    expect(screen.getByText('Connected')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(host.getListCalls()).toBe(2);
  });

  it('renders snapshot status badges and exposes failed status reason in a tooltip', async () => {
    const provider: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([
      sandboxEntry({
        provider,
        status: 'failed',
        statusReason: 'Snapshot image could not be built',
      }),
    ]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Sync failed')).toBeTruthy();
    });
    expect(screen.queryByText('Connected')).toBeNull();

    fireEvent.mouseEnter(screen.getByLabelText('Snapshot sync status details'));
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Snapshot image could not be built');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(host.updated).toHaveLength(1);
    });
    expect(host.updated[0]).toEqual({
      id: 'sb-1',
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    });
    expect(host.updated[0]).not.toHaveProperty('apiKey');
  });

  it('warns that a removed Daytona provider leaves its sandboxes behind', async () => {
    const existing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([sandboxEntry({ provider: existing })], { withDelete: true });
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByText(/The stored API key is deleted/)).toBeTruthy();
    });
    expect(screen.getByText(/left for the provider to auto-stop and auto-delete/)).toBeTruthy();
    expect(host.deleted).toEqual([]);

    const [, confirm] = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(confirm ?? screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(host.deleted).toEqual(['sb-1']);
    });
  });

  describe('the built-in provider', () => {
    it('enables straight from the list, with no form and no credentials', async () => {
      const host = createFakeHost([], { catalog: [builtInCatalogEntry], withDelete: true });
      const { wrapper: Wrapper } = host;
      render(
        <Wrapper>
          <SandboxSettings />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText('Cloudflare Computer')).toBeTruthy();
      });
      // Daytona is not offered here, so there is nothing to configure.
      expect(screen.queryByText('Daytona')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

      await waitFor(() => {
        expect(host.created).toHaveLength(1);
      });
      // One click enabled it: no form was opened and no credential was collected.
      expect(host.created[0]).toMatchObject({
        catalogId: 'cloudflare-computer',
        type: 'cloudflare-computer',
        apiKey: '',
      });
      for (const dialog of screen.getAllByRole('dialog', { hidden: true })) {
        expect(dialog.hasAttribute('open')).toBe(false);
      }
    });

    it('shows a status line and disables again, with nothing to update', async () => {
      const host = createFakeHost([sandboxEntry({ provider: builtInProvider })], {
        catalog: [builtInCatalogEntry],
        withDelete: true,
      });
      const { wrapper: Wrapper } = host;
      render(
        <Wrapper>
          <SandboxSettings />
        </Wrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText('Connected')).toBeTruthy();
      });
      expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

      // Disabling asks first, and cancelling leaves the provider alone.
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
      await waitFor(() => {
        expect(screen.getByText(/Agents lose the sandbox/)).toBeTruthy();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(host.deleted).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
      await waitFor(() => {
        expect(screen.getByText(/Agents lose the sandbox/)).toBeTruthy();
      });
      const [, confirm] = screen.getAllByRole('button', { name: 'Disable' });
      fireEvent.click(confirm ?? screen.getByRole('button', { name: 'Disable' }));

      await waitFor(() => {
        expect(host.deleted).toEqual(['cloudflare-computer']);
      });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
      });
    });
  });
});
