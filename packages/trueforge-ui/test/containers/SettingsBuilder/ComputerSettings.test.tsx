// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import ComputerSettings from '@/containers/SettingsBuilder/ComputerSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentUIServer, ComputerAuditEntry, ComputerBase, ComputerCatalogServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

async function unavailable(): Promise<never> {
  throw new Error('Unexpected computer catalog call');
}

const ONLINE: ComputerBase = {
  id: 'cmp-1',
  name: 'office-box',
  status: 'online',
  hostname: 'office.local',
  os: 'linux',
  arch: 'amd64',
  agentVersion: '0.1.0',
  tools: { python3: true, git: true },
  runAsUser: 'trueforge',
  requireApproval: true,
  lastSeenAt: '2026-09-21T10:00:00.000Z',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const PENDING: ComputerBase = {
  ...ONLINE,
  id: 'cmp-2',
  name: 'spare-laptop',
  status: 'pending',
  hostname: null,
  os: null,
  arch: null,
  agentVersion: null,
  tools: null,
  runAsUser: null,
  lastSeenAt: null,
};

const ENROLLMENT = {
  enrollmentCode: 'code-abc',
  installCommand:
    'curl -fsSL https://trueforge.test/install.sh | sh -s -- --url https://trueforge.test --code code-abc',
  dockerCommand: 'docker run -d ghcr.io/truefoundry/trueforge-computer --url https://trueforge.test --code code-abc',
};

function auditEntry(overrides: Partial<ComputerAuditEntry> = {}): ComputerAuditEntry {
  return {
    id: 'aud-1',
    computerId: 'cmp-1',
    computerName: 'office-box',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    op: 'exec',
    command: 'uname -a',
    exitCode: 0,
    outcome: 'ok',
    durationMs: 12,
    bytesOut: 40,
    createdAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  };
}

function renderSection(
  catalog: Partial<ComputerCatalogServer> & { listComputers: () => Promise<ComputerBase[]> },
  serverOverrides: Partial<AgentUIServer> = {},
) {
  const computerCatalog: ComputerCatalogServer = {
    createComputer: unavailable,
    getComputer: unavailable,
    updateComputer: unavailable,
    deleteComputer: unavailable,
    getComputerAgentAccess: async () => [],
    putComputerAgentAccess: unavailable,
    rotateComputerEnrollment: unavailable,
    revokeComputer: unavailable,
    listComputerAudit: async () => ({ data: [] }),
    ...catalog,
  };
  const server = createMockAgentUIServer({
    catalog: createMockCatalog({ computerCatalog }),
    ...serverOverrides,
  });
  const ui = (
    <ServerProvider server={server}>
      <ComputerSettings />
    </ServerProvider>
  );
  return { ...render(ui), ui };
}

function stubClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
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

describe('ComputerSettings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('warns that a computer is a real machine', async () => {
    renderSection({ listComputers: async () => [] });

    expect(await screen.findByText(/This is a real machine, not a sandbox/)).toBeInTheDocument();
    expect(screen.getByText(/can steer what it runs/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is enrolled', async () => {
    renderSection({ listComputers: async () => [] });

    expect(await screen.findByText('No computers yet.')).toBeInTheDocument();
  });

  it('lists each computer with its status and what it reported', async () => {
    renderSection({ listComputers: async () => [ONLINE, PENDING] });

    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Waiting to enroll')).toBeInTheDocument();
    expect(screen.getByText(/office\.local · linux · 0\.1\.0 · as trueforge · python3, git/)).toBeInTheDocument();
    expect(screen.getByText(/no hostname yet · unknown OS/)).toBeInTheDocument();
  });

  it('keeps the one-time enrollment on screen across a re-render and the list refresh', async () => {
    let listed: ComputerBase[] = [];
    const createComputer = vi.fn(async () => {
      // The refresh that follows create must not take the panel away.
      listed = [PENDING];
      return { computer: PENDING, enrollment: ENROLLMENT };
    });
    const { rerender, ui } = renderSection({ listComputers: async () => listed, createComputer });

    fireEvent.click(await screen.findByRole('button', { name: /Add computer/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'spare-laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(ENROLLMENT.installCommand)).toBeInTheDocument();
    expect(createComputer).toHaveBeenCalledWith({ name: 'spare-laptop', requireApproval: true });
    expect(screen.getByText(/single-use, expires in 15 minutes, and cannot be shown again/)).toBeInTheDocument();

    // The list arrives underneath; the panel is component state, not derived from it.
    await screen.findByText('Waiting to enroll');
    rerender(ui);
    expect(screen.getByText(ENROLLMENT.installCommand)).toBeInTheDocument();
    expect(screen.getByText(ENROLLMENT.dockerCommand)).toBeInTheDocument();
  });

  it('copies each command from its own button', async () => {
    const writeText = stubClipboard();
    renderSection({
      listComputers: async () => [],
      createComputer: async () => ({ computer: PENDING, enrollment: ENROLLMENT }),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Add computer/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'spare-laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    fireEvent.click(await screen.findByRole('button', { name: /Copy install command/ }));
    fireEvent.click(screen.getByRole('button', { name: /Copy docker command/ }));

    await waitFor(() => {
      expect(writeText).toHaveBeenNthCalledWith(1, ENROLLMENT.installCommand);
      expect(writeText).toHaveBeenNthCalledWith(2, ENROLLMENT.dockerCommand);
    });
  });

  it('says the approval flag is stored but not enforced', async () => {
    renderSection({ listComputers: async () => [ONLINE] });

    fireEvent.click(await screen.findByText('office-box'));

    expect(await screen.findByText(/Stored now, enforced from a later release/)).toBeInTheDocument();
  });

  it('says the approval flag is live when the server enforces it', async () => {
    renderSection({ listComputers: async () => [{ ...ONLINE, approvalEnforced: true }] });

    fireEvent.click(await screen.findByText('office-box'));

    expect(await screen.findByText(/A person has to approve every command/)).toBeInTheDocument();
  });

  it('shows the server 422 for an unknown agent name beside the access editor', async () => {
    const putComputerAgentAccess = vi.fn(async () => {
      throw { statusCode: 422, body: { error: { message: 'No such agent: ghost' } } };
    });
    renderSection({ listComputers: async () => [ONLINE], putComputerAgentAccess });

    fireEvent.click(await screen.findByText('office-box'));
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'ghost' } });
    fireEvent.click(screen.getByRole('button', { name: /Grant/ }));

    expect(await screen.findByText('No such agent: ghost')).toBeInTheDocument();
    expect(putComputerAgentAccess).toHaveBeenCalledWith({ computerId: 'cmp-1', agentNames: ['ghost'] });
  });

  it('states that granting an agent trusts whoever can edit it', async () => {
    renderSection({ listComputers: async () => [ONLINE] });

    fireEvent.click(await screen.findByText('office-box'));

    expect(await screen.findByText(/trusts everyone who can edit that agent/)).toBeInTheDocument();
  });

  it('disables delete while an agent is granted, and surfaces the 409 when it is not', async () => {
    const deleteComputer = vi.fn(async () => {
      throw { statusCode: 409, body: { error: { message: '1 agent(s) are still allowed to use this computer' } } };
    });
    const { unmount } = renderSection({
      listComputers: async () => [ONLINE],
      getComputerAgentAccess: async () => ['release-bot'],
      deleteComputer,
    });

    fireEvent.click(await screen.findByText('office-box'));

    const disabled = await screen.findByRole('button', { name: /Delete/ });
    expect(disabled).toBeDisabled();
    expect(
      screen.getByText(/1 agent\(s\) are still allowed to use this computer — remove their access/),
    ).toBeInTheDocument();
    unmount();

    // A grant added elsewhere between the read and the delete still loses; the server says so.
    renderSection({ listComputers: async () => [ONLINE], getComputerAgentAccess: async () => [], deleteComputer });
    fireEvent.click(await screen.findByText('office-box'));
    const enabled = await screen.findByRole('button', { name: /Delete/ });
    await waitFor(() => {
      expect(enabled).toBeEnabled();
    });
    fireEvent.click(enabled);

    expect(await screen.findByText('1 agent(s) are still allowed to use this computer')).toBeInTheDocument();
  });

  it('confirms before rotating, and shows the new code once', async () => {
    const rotateComputerEnrollment = vi.fn(async () => ENROLLMENT);
    renderSection({ listComputers: async () => [ONLINE], rotateComputerEnrollment });

    fireEvent.click(await screen.findByText('office-box'));
    fireEvent.click(await screen.findByRole('button', { name: /Rotate enrollment/ }));

    expect(await screen.findByText(/The machine has to enroll again with the new code/)).toBeInTheDocument();
    expect(rotateComputerEnrollment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText(ENROLLMENT.installCommand)).toBeInTheDocument();
    expect(rotateComputerEnrollment).toHaveBeenCalledWith({ computerId: 'cmp-1' });
  });

  it('confirms before revoking and says it is terminal', async () => {
    const revokeComputer = vi.fn(async () => ({ ...ONLINE, status: 'revoked' as const }));
    renderSection({ listComputers: async () => [ONLINE], revokeComputer });

    fireEvent.click(await screen.findByText('office-box'));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText(/the live connection closes\. This cannot be undone/)).toBeInTheDocument();
    expect(revokeComputer).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Revoke' })[1] ?? screen.getByRole('button', { name: 'Revoke' }),
    );

    await waitFor(() => {
      expect(revokeComputer).toHaveBeenCalledWith({ computerId: 'cmp-1' });
    });
  });

  it('pages the audit list and expands a truncated command', async () => {
    const longCommand = `git clone ${'x'.repeat(200)}`;
    const listComputerAudit = vi.fn(async (req: { computerId: string; limit?: number; pageToken?: string }) =>
      req.pageToken === undefined
        ? { data: [auditEntry({ command: longCommand })], nextPageToken: 'page-2' }
        : { data: [auditEntry({ id: 'aud-2', command: 'ls', outcome: 'offline', exitCode: null })] },
    );
    renderSection({ listComputers: async () => [ONLINE], listComputerAudit });

    fireEvent.click(await screen.findByText('office-box'));

    expect(await screen.findByText(`git clone ${'x'.repeat(110)}…`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText(longCommand)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('ls')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('exit unknown')).toBeInTheDocument();
    expect(listComputerAudit).toHaveBeenLastCalledWith({ computerId: 'cmp-1', limit: 25, pageToken: 'page-2' });
  });
});
