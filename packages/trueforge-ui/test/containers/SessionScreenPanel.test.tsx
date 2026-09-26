import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/ServerContext.js', () => ({ useOptionalComputerDesktopServer: () => ({}) }));
vi.mock('@/atoms/desktop/DesktopScreen.js', () => ({ DesktopScreen: () => <div data-testid="desktop-screen" /> }));

import { SessionScreenPanel, SessionScreenToggle } from '@/containers/SessionScreenPanel.js';

describe('SessionScreenToggle', () => {
  it('only shows from md up, where the Screen panel fits beside the chat', () => {
    const onToggle = vi.fn();
    render(<SessionScreenToggle open={false} onToggle={onToggle} />);
    const toggle = screen.getByRole('button', { name: 'Show screen' });
    expect(toggle).toHaveClass('hidden', 'md:inline-flex');
    expect(toggle).not.toHaveClass('inline-flex');

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('SessionScreenPanel', () => {
  const panelScreen = { agentId: 'agent-1', computerId: 'computer-1', sessionId: 'session-1' };
  let narrow = false;
  const listeners = new Set<() => void>();

  function stubMatchMedia() {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return narrow;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    listeners.clear();
  });

  it('does not mount the desktop view below md, so nothing polls while it cannot be seen', () => {
    narrow = true;
    stubMatchMedia();
    render(<SessionScreenPanel screen={panelScreen} onClose={() => undefined} />);
    expect(screen.queryByRole('complementary', { name: 'Screen' })).toBeNull();
    expect(screen.queryByTestId('desktop-screen')).toBeNull();
  });

  it('unmounts the desktop view when the window narrows below md', () => {
    narrow = false;
    stubMatchMedia();
    render(<SessionScreenPanel screen={panelScreen} onClose={() => undefined} />);
    expect(screen.getByTestId('desktop-screen')).toBeInTheDocument();

    act(() => {
      narrow = true;
      for (const listener of listeners) listener();
    });
    expect(screen.queryByTestId('desktop-screen')).toBeNull();
  });
});
