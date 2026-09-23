'use client';

import { useDesktopAgent } from '../hooks/useDesktopAgent.js';
import { buildAgentScreenHref } from '../routing/paths.js';
import { useOptionalResolvedRoutes } from '../routing/ResolvedRoutesContext.js';
import { useOptionalComputerDesktopServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { replaceSessionShareSearch } from '../utils/sessionShareUrl.js';
import { parseTakeoverAnswer, parseTakeoverReason } from '../utils/toolCallParsing.js';

/** A `request_human_takeover` call: the reason, and while it waits a way to the agent's Screen page. */
export function HumanTakeoverContainer({ argsText, result }: { argsText: string; result: unknown }) {
  const HumanTakeoverCard = useSlot('HumanTakeoverCard');
  const shell = useOptionalShellMode();
  const routes = useOptionalResolvedRoutes();
  const desktop = useOptionalComputerDesktopServer();
  const answer = parseTakeoverAnswer(result);
  const mode = shell?.mode;
  const named = mode?.status === 'active' && !mode.isMutable;
  const agent = useDesktopAgent({
    agentId: named ? mode.agentId : undefined,
    agentName: named ? mode.agentName : undefined,
    enabled: desktop !== null && named && answer === undefined,
  });

  const reason = parseTakeoverReason(argsText) ?? 'The agent asked for a person to take over its desktop.';
  const agentId = agent?.agentId;
  const screenHref = agentId === undefined || routes === null ? null : buildAgentScreenHref({ agentId, routes });

  return (
    <HumanTakeoverCard
      reason={reason}
      {...(answer === undefined ? {} : { answer })}
      {...(screenHref === null ? {} : { screenHref })}
      {...(agentId === undefined || shell === null
        ? {}
        : {
            onOpenScreen: () => {
              replaceSessionShareSearch({ agentId, tab: 'screen', sessionId: null, view: null, timeRange: null });
              shell.openLibraryAgent(agentId);
            },
          })}
    />
  );
}
