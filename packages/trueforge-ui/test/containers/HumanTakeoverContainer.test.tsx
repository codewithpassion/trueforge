import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HumanTakeoverContainer } from '@/containers/HumanTakeoverContainer.js';
import type { DesktopAgent } from '@/hooks/useDesktopAgent.js';
import { resolveRoutesConfig } from '@/routing/paths.js';
import type { ResolvedRoutes } from '@/routing/types.js';

type MockState = {
  openLibraryAgent: ReturnType<typeof vi.fn>;
  desktopAgent: DesktopAgent | null;
  routes: ResolvedRoutes | null;
};

const mocks = vi.hoisted(() => {
  const state: MockState = { openLibraryAgent: vi.fn(), desktopAgent: null, routes: null };
  return state;
});

vi.mock('@/hooks/useDesktopAgent.js', () => ({ useDesktopAgent: () => mocks.desktopAgent }));
vi.mock('@/routing/ResolvedRoutesContext.js', () => ({ useOptionalResolvedRoutes: () => mocks.routes }));
vi.mock('@/server/ServerContext.js', () => ({ useOptionalComputerDesktopServer: () => ({}) }));
vi.mock('@/server/ShellModeContext.js', () => ({
  useOptionalShellMode: () => ({
    mode: { status: 'active', isMutable: false, isCreateAgent: false, agentName: 'portal-bot', locked: false },
    openLibraryAgent: mocks.openLibraryAgent,
  }),
}));

beforeEach(() => {
  mocks.openLibraryAgent.mockReset();
  mocks.desktopAgent = { agentId: 'agent-1', computerId: 'computer-1' };
  mocks.routes = resolveRoutesConfig({ basename: '/tf' });
  window.history.replaceState(null, '', '/tf/sessions/session-1');
});

describe('HumanTakeoverContainer', () => {
  it('links a waiting request to the agent Screen tab', () => {
    render(<HumanTakeoverContainer argsText='{"reason":"Log into the supplier portal"}' result={undefined} />);

    expect(screen.getByText('Log into the supplier portal')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open screen/ });
    expect(link).toHaveAttribute('href', '/tf/agents/agent-1/screen');
  });

  it('opens the Screen tab inside the app on a plain click', () => {
    render(<HumanTakeoverContainer argsText='{"reason":"Log in"}' result={undefined} />);
    fireEvent.click(screen.getByRole('link', { name: /Open screen/ }));

    expect(mocks.openLibraryAgent).toHaveBeenCalledWith('agent-1');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('screen');
  });

  it('shows the answer instead of the link once the request was answered', () => {
    render(
      <HumanTakeoverContainer
        argsText='{"reason":"Log in"}'
        result='{"outcome":"completed","note":"Logged in as accounts","answered_by":"another_user"}'
      />,
    );
    expect(screen.queryByRole('link', { name: /Open screen/ })).toBeNull();
    expect(screen.getByText('Another person handed the desktop back: “Logged in as accounts”')).toBeInTheDocument();
  });

  it('says where to go when the Screen page cannot be linked', () => {
    mocks.desktopAgent = null;
    render(<HumanTakeoverContainer argsText='{"reason":"Log in"}' result={undefined} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Open the agent’s Screen page/)).toBeInTheDocument();
  });
});
