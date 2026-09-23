// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentOverflowMenu } from '@/atoms/AgentOverflowMenu.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSpec, SaveAgentRequest, SaveAgentResult } from '@/server/types.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

function renderMenu(
  agentSpec: AgentSpec,
  { description }: { description?: string } = { description: 'runs the release' },
) {
  const saved: SaveAgentRequest[] = [];
  const saveAgent = vi.fn(async (request: SaveAgentRequest): Promise<SaveAgentResult> => {
    saved.push(request);
    return { agentId: 'agent-2' };
  });
  render(
    <ServerProvider server={createMockAgentUIServer({ saveAgent })}>
      <AgentOverflowMenu
        agentName="release-bot"
        {...(description === undefined ? {} : { description })}
        agentSpec={agentSpec}
        canMutate
        canManageSchedules={false}
        onEdit={() => undefined}
      />
    </ServerProvider>,
  );
  return saved;
}

async function clone() {
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for release-bot' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Clone' }));
  const drawer = await screen.findByRole('dialog', { name: 'Clone Agent' });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
}

describe('AgentOverflowMenu clone', () => {
  it('does not carry the source agent’s computer into the clone', async () => {
    const saved = renderMenu({
      model: { name: 'openai-main/gpt-4.1' },
      config: { iterationLimit: 20, sandbox: { enabled: true, fileDownloads: false, computerId: 'cmp-1' } },
    });

    await clone();

    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const request = saved[0];
    expect(request?.intent).toBe('create');
    expect(request?.agentName).toBe('release-bot-clone');
    // A computer is granted against the source agent's id; the clone has none yet, and the
    // server refuses a computer at create.
    expect(request?.agentSpec.config).toEqual({
      iterationLimit: 20,
      sandbox: { enabled: true, fileDownloads: false },
    });
  });

  it('leaves a spec without a computer exactly as it was', async () => {
    const saved = renderMenu({
      model: { name: 'openai-main/gpt-4.1' },
      config: { sandbox: { enabled: true } },
    });

    await clone();

    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.agentSpec.config).toEqual({ sandbox: { enabled: true } });
  });

  it('clones an agent that has no description without inventing one', async () => {
    const saved = renderMenu({ model: { name: 'openai-main/gpt-4.1' } }, {});

    await clone();

    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.description).toBe('');
  });
});
