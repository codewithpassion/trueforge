'use client';

import { useEffect, useState } from 'react';

import { findAgentByName } from '../atoms/lib/useSearchAgentsList.js';
import { useOptionalAgentSessionsServer, useOptionalServer } from '../server/ServerContext.js';
import { desktopComputerId } from '../utils/desktopAgent.js';

export type DesktopAgent = { agentId: string; computerId: string };

/**
 * The saved agent's id and the computer whose desktop it drives, or null while unknown or when it
 * drives none. A session opened from a link may know the agent by name only.
 */
export function useDesktopAgent({
  agentId,
  agentName,
  enabled,
}: {
  agentId: string | undefined;
  agentName: string | undefined;
  enabled: boolean;
}): DesktopAgent | null {
  const server = useOptionalServer();
  const sessions = useOptionalAgentSessionsServer();
  const [resolved, setResolved] = useState<DesktopAgent | null>(null);

  useEffect(() => {
    setResolved(null);
    if (!enabled || server === null || (agentId === undefined && agentName === undefined)) return;
    let cancelled = false;
    const resolve = async (): Promise<DesktopAgent | null> => {
      // A shell bound by name may carry the name in `agentId` too, so the name is the safer key.
      let id = agentName === undefined ? agentId : undefined;
      if (agentName !== undefined) {
        const entry = await findAgentByName({ server, agentName });
        if (entry?.agentId === undefined) return null;
        id = entry.agentId;
        const fromEntry = desktopComputerId(entry.agentSpec);
        if (fromEntry !== undefined) return { agentId: id, computerId: fromEntry };
      }
      if (id === undefined || sessions === null) return null;
      const detail = await sessions.getAgent({ agentId: id });
      const computerId = desktopComputerId(detail.agentSpec);
      return computerId === undefined ? null : { agentId: detail.agentId, computerId };
    };
    resolve().then(
      next => {
        if (!cancelled) setResolved(next);
      },
      () => {
        // An agent that cannot be read has no Screen to offer; nothing else depends on it.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, agentName, enabled, server, sessions]);

  return resolved;
}
