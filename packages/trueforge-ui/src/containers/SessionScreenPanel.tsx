'use client';

import { useAuiState } from '@assistant-ui/react';

import { DesktopScreen } from '../atoms/desktop/DesktopScreen.js';
import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { useDesktopAgent, type DesktopAgent } from '../hooks/useDesktopAgent.js';
import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalComputerDesktopServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';

export type SessionScreen = DesktopAgent & { sessionId: string };

/**
 * The desktop behind the open chat, for the person who owns the session: a saved agent that
 * drives a computer's desktop, on a host that can show it.
 */
export function useSessionScreen(): SessionScreen | null {
  const shell = useOptionalShellMode();
  const desktop = useOptionalComputerDesktopServer();
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const canManage = useActiveSessionCanManage();
  const mode = shell?.mode;
  const named = mode?.status === 'active' && !mode.isMutable;
  const agent = useDesktopAgent({
    agentId: named ? mode.agentId : undefined,
    agentName: named ? mode.agentName : undefined,
    enabled: desktop !== null && named && sessionId != null && canManage,
  });
  if (agent === null || sessionId == null || !canManage) return null;
  return { ...agent, sessionId };
}

export function SessionScreenToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-label={open ? 'Hide screen' : 'Show screen'}
      title={open ? 'Hide screen' : 'Show screen'}
      // The panel only fits beside the chat from md up, so there is nothing to toggle below that.
      className={auiButtonClass({ variant: 'ghost', size: 'icon', className: 'hidden md:inline-flex' })}
      onClick={onToggle}
    >
      <Icon name="monitor" />
    </button>
  );
}

/** Right-side panel beside the chat with the live desktop the agent is using. */
export function SessionScreenPanel({ screen, onClose }: { screen: SessionScreen; onClose: () => void }) {
  const server = useOptionalComputerDesktopServer();
  // Below md there is no room beside the chat. The view stays mounted and only pauses, because
  // unmounting it would hand back control someone holds just because the window got narrower.
  const narrow = useIsMobile();
  if (server === null) return null;
  return (
    <aside
      aria-label="Screen"
      hidden={narrow}
      className={cn(
        'min-h-0 w-[30rem] shrink-0 flex-col border-l border-border bg-primary-bg 2xl:w-[40rem]',
        narrow ? 'hidden' : 'flex',
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-sm font-semibold text-text-primary">Screen</h2>
        <button
          type="button"
          aria-label="Close screen"
          className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
          onClick={onClose}
        >
          <Icon name="xmark" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <DesktopScreen
          key={`${screen.computerId}:${screen.agentId}`}
          server={server}
          computerId={screen.computerId}
          agentId={screen.agentId}
          sessionId={screen.sessionId}
          compact
          paused={narrow}
        />
      </div>
    </aside>
  );
}
