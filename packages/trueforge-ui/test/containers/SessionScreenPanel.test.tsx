import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/ServerContext.js', () => ({ useOptionalComputerDesktopServer: () => ({}) }));
const mounts = vi.fn();
vi.mock('@/atoms/desktop/DesktopScreen.js', async () => {
  const { useEffect } = await import('react');
  return {
    DesktopScreen: ({ paused }: { paused?: boolean }) => {
      useEffect(() => {
        mounts();
      }, []);
      return <div data-testid="desktop-screen" data-paused={String(paused)} />;
    },
  };
});

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

  it('keeps the desktop view mounted but paused below md, where it cannot be seen', () => {
    narrow = true;
    stubMatchMedia();
    render(<SessionScreenPanel screen={panelScreen} onClose={() => undefined} />);
    expect(screen.getByTestId('desktop-screen')).toHaveAttribute('data-paused', 'true');
    expect(screen.getByLabelText('Screen')).toHaveClass('hidden');
  });

  it('pauses rather than unmounts when the window narrows, and resumes when it widens', () => {
    narrow = false;
    mounts.mockClear();
    stubMatchMedia();
    render(<SessionScreenPanel screen={panelScreen} onClose={() => undefined} />);
    expect(screen.getByTestId('desktop-screen')).toHaveAttribute('data-paused', 'false');

    act(() => {
      narrow = true;
      for (const listener of listeners) listener();
    });
    expect(screen.getByTestId('desktop-screen')).toHaveAttribute('data-paused', 'true');

    act(() => {
      narrow = false;
      for (const listener of listeners) listener();
    });
    expect(screen.getByTestId('desktop-screen')).toHaveAttribute('data-paused', 'false');
    expect(screen.getByLabelText('Screen')).toHaveClass('flex');
    // One mount throughout, so the view's leave-cleanup never hands back control.
    expect(mounts).toHaveBeenCalledTimes(1);
  });
});
