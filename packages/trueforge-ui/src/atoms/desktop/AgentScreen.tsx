'use client';

import type { ComponentType } from 'react';

import type { ComputerDesktopServer } from '../../server/types.js';
import { DesktopScreen } from './DesktopScreen.js';

export type AgentScreenProps = {
  server: ComputerDesktopServer;
  agentId: string;
  computerId: string;
};

/** The agent page's Screen tab: the desktop of the computer the agent drives. */
export function AgentScreen({ server, agentId, computerId }: AgentScreenProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <p className="mb-3 text-sm text-text-secondary">
        The computer&rsquo;s shared screen. Every agent on this computer sees the same desktop, and while you hold
        control no agent there can run anything.
      </p>
      <DesktopScreen server={server} agentId={agentId} computerId={computerId} />
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentScreen: ComponentType<AgentScreenProps>;
  }
}
